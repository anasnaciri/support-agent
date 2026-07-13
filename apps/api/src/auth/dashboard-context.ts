import { Effect } from "effect";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  DATA_PROCESSING_NOTICE_VERSION,
  DPA_VERSION,
  legalAcceptanceIsCurrent,
  TenantRepository,
  type LegalAcceptance,
} from "@support-agent/services";
import { TenantId } from "@support-agent/agent-core";
import {
  DbClient,
  findTenantIdByWorkosOrg,
  findWorkspaceForOrg,
  getMemberAccess,
  getFulfillmentOperatorForUser,
  type DrizzleDb,
} from "@support-agent/db";
import { type RbacPermissionId } from "@support-agent/dashboard-contracts";
import { decideAuthz } from "./dashboard-authz.js";
import {
  authenticateDashboardCredential,
  isWorkspaceIdShape,
} from "./dashboard-auth.js";
import { type DashboardTokenVerifier } from "./dashboard-jwt.js";
import { type SessionCodec } from "./dashboard-session.js";
import {
  type WorkosOrgAdminDirectory,
  type WorkosOrganizationDirectory,
  type WorkosUserDirectory,
} from "./workos-directory.js";
import { type ApiConfig, type ApiLayer } from "../bootstrap.js";
import { sendJson } from "../platform/http.js";

// ============================================================
// Dashboard read API (Path B) — shared request context
// ============================================================

/** Run a Promise-returning DB query against the api layer's DbClient. */
export const runWithDb = <T>(
  layer: ApiLayer,
  f: (db: DrizzleDb) => Promise<T>,
): Promise<T> =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const db = yield* DbClient;
        return yield* Effect.promise(() => f(db));
      }),
      layer,
    ),
  );

export type DashboardAuthResult =
  | {
      readonly ok: true;
      readonly tenantId: string;
      /** The verified WorkOS organization id — for server-side WorkOS writes
       *  (e.g. sendInvitation needs the org, not our tenant id). */
      readonly organizationId: string;
      readonly userId: string | undefined;
      /** Verified WorkOS user id (`sub`) — for the verified-email lookup. */
      readonly workosUserId: string | undefined;
      readonly userEmail: string | undefined;
    }
  | { readonly ok: false; readonly status: number; readonly error: string };

// Per-request memo so the centralized RBAC guard (in dashboardGet/dashboardPost)
// and the handler's own authenticateDashboard call share ONE workspace
// resolution instead of querying twice.
const kDashAuth = Symbol("dashboardAuth");

/**
 * The WorkOS access-token verifier is built once at boot and decorated onto the
 * Fastify instance (see startServer); every `/dashboard/*` request reads it
 * from `req.server`. `null` → WorkOS isn't configured, so the dashboard API is
 * not available (503).
 */
export const getDashboardVerifier = (
  req: FastifyRequest,
): DashboardTokenVerifier | null =>
  (req.server as unknown as {
    dashboardTokenVerifier: DashboardTokenVerifier | null;
  }).dashboardTokenVerifier;

/**
 * The SPA BFF session codec (seal/unseal the httpOnly cookie), decorated at
 * boot alongside the verifier. `null` → the BFF isn't configured, so the cookie
 * credential is unavailable and only the forwarded-bearer path works.
 */
export const getDashboardSessionCodec = (
  req: FastifyRequest,
): SessionCodec | null =>
  (req.server as unknown as {
    dashboardSessionCodec: SessionCodec | null;
  }).dashboardSessionCodec;

/**
 * The WorkOS user directory (verified-email lookup), decorated alongside the
 * verifier. `null` → no `WORKOS_API_KEY`, so invite reconcile degrades to a
 * no-op rather than ever trusting the `x-user-email` header.
 */
export const getWorkosDirectory = (
  req: FastifyRequest,
): WorkosUserDirectory | null =>
  (req.server as unknown as {
    workosUserDirectory: WorkosUserDirectory | null;
  }).workosUserDirectory;

/**
 * The WorkOS organization directory (org-name lookup), decorated alongside the
 * user directory. `null` → no `WORKOS_API_KEY`, so the admin console shows just
 * the opaque org id rather than a name.
 */
export const getWorkosOrganizationDirectory = (
  req: FastifyRequest,
): WorkosOrganizationDirectory | null =>
  (req.server as unknown as {
    workosOrganizationDirectory: WorkosOrganizationDirectory | null;
  }).workosOrganizationDirectory;

/**
 * The WorkOS org-admin (WRITE) directory — create org / add member / list
 * memberships / send invitation. `null` → no `WORKOS_API_KEY`, so the SPA
 * onboarding + server-side invite paths respond 503. Decorated alongside the
 * read directories.
 */
export const getWorkosOrgAdminDirectory = (
  req: FastifyRequest,
): WorkosOrgAdminDirectory | null =>
  (req.server as unknown as {
    workosOrgAdminDirectory: WorkosOrgAdminDirectory | null;
  }).workosOrgAdminDirectory;

export const resolveDashboardAuth = async (
  layer: ApiLayer,
  req: FastifyRequest,
): Promise<DashboardAuthResult> => {
  const verifier = getDashboardVerifier(req);
  if (!verifier) {
    return { ok: false, status: 503, error: "dashboard_api_not_configured" };
  }
  const parsed = await authenticateDashboardCredential(
    req.headers as Record<string, string | undefined>,
    verifier,
    getDashboardSessionCodec(req),
  );
  if (!parsed.ok) {
    return { ok: false, status: parsed.status, error: parsed.message };
  }
  if (parsed.workspaceId !== undefined) {
    if (!isWorkspaceIdShape(parsed.workspaceId)) {
      return { ok: false, status: 400, error: "invalid_workspace_id" };
    }
    const workspace = await runWithDb(layer, (db) =>
      findWorkspaceForOrg(db, parsed.organizationId, parsed.workspaceId!),
    );
    if (!workspace) {
      return { ok: false, status: 404, error: "workspace_not_found" };
    }
    return {
      ok: true,
      tenantId: workspace.id,
      organizationId: parsed.organizationId,
      userId: parsed.userId,
      workosUserId: parsed.workosUserId,
      userEmail: parsed.userEmail,
    };
  }
  const tenantId = await runWithDb(layer, (db) =>
    findTenantIdByWorkosOrg(db, parsed.organizationId),
  );
  if (!tenantId) {
    return { ok: false, status: 403, error: "no_tenant_for_organization" };
  }
  return {
    ok: true,
    tenantId,
    organizationId: parsed.organizationId,
    userId: parsed.userId,
    workosUserId: parsed.workosUserId,
    userEmail: parsed.userEmail,
  };
};

export const authenticateDashboard = async (
  _cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
): Promise<DashboardAuthResult> => {
  const store = req as unknown as Record<symbol, DashboardAuthResult | undefined>;
  const cached = store[kDashAuth];
  if (cached) return cached;
  const result = await resolveDashboardAuth(layer, req);
  store[kDashAuth] = result;
  return result;
};

// Per-request memo for the fulfillment partner auth path (parallels kDashAuth) so the RBAC
// guard in fulfillmentOperatorGet/fulfillment-operatorPost and the handler share ONE resolution.
const kFulfillmentOperatorAuth = Symbol("fulfillmentOperatorAuth");

/**
 * Org-INDEPENDENT fulfillmentOperator auth. Verify the credential for IDENTITY ONLY, then
 * resolve the tenant purely from the `x-workspace-id` header VALIDATED BY THE
 * FULFILLMENT_OPERATOR BINDING (a `fulfillmentOperators` row for this user in that workspace). The
 * JWT's `org_id` is deliberately NOT consulted — a fulfillment partner reaches a merchant's
 * tenant because they're bound to it, not because they belong to that WorkOS org
 * (a fulfillment partner serves merchants across many orgs). A workspace the fulfillment partner isn't
 * bound to → 404 (disclosure-safe, mirrors `findWorkspaceForOrg`).
 */
export const resolveFulfillmentOperatorAuth = async (
  layer: ApiLayer,
  req: FastifyRequest,
): Promise<DashboardAuthResult> => {
  const verifier = getDashboardVerifier(req);
  if (!verifier) {
    return { ok: false, status: 503, error: "dashboard_api_not_configured" };
  }
  const parsed = await authenticateDashboardCredential(
    req.headers as Record<string, string | undefined>,
    verifier,
    getDashboardSessionCodec(req),
  );
  if (!parsed.ok) {
    return { ok: false, status: parsed.status, error: parsed.message };
  }
  if (!parsed.userId) {
    return { ok: false, status: 401, error: "missing_user" };
  }
  if (parsed.workspaceId === undefined) {
    return { ok: false, status: 400, error: "missing_workspace" };
  }
  if (!isWorkspaceIdShape(parsed.workspaceId)) {
    return { ok: false, status: 400, error: "invalid_workspace_id" };
  }
  const workspaceId = parsed.workspaceId;
  const userId = parsed.userId;
  const fulfillmentOperator = await runWithDb(layer, (db) =>
    getFulfillmentOperatorForUser(db, workspaceId, userId),
  );
  if (!fulfillmentOperator) {
    return { ok: false, status: 404, error: "workspace_not_found" };
  }
  return {
    ok: true,
    tenantId: workspaceId,
    organizationId: parsed.organizationId,
    userId,
    workosUserId: parsed.workosUserId,
    userEmail: parsed.userEmail,
  };
};

export const authenticateFulfillmentOperator = async (
  _cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
): Promise<DashboardAuthResult> => {
  const store = req as unknown as Record<symbol, DashboardAuthResult | undefined>;
  const cached = store[kFulfillmentOperatorAuth];
  if (cached) return cached;
  const result = await resolveFulfillmentOperatorAuth(layer, req);
  store[kFulfillmentOperatorAuth] = result;
  return result;
};

export type FulfillmentOperatorIdentityResult =
  | {
      readonly ok: true;
      readonly userId: string;
      readonly workosUserId: string | undefined;
      readonly userEmail: string | undefined;
    }
  | { readonly ok: false; readonly status: number; readonly error: string };

/**
 * Identity-only auth for the fulfillment partner bootstrap endpoint
 * (`GET /dashboard/fulfillment-operator/workspaces`): verify the credential and require a
 * user, but require NO `x-workspace-id` and consult NO org — the caller lists
 * the workspaces the user is bound to across all orgs.
 */
export const authenticateFulfillmentOperatorIdentity = async (
  req: FastifyRequest,
): Promise<FulfillmentOperatorIdentityResult> => {
  const verifier = getDashboardVerifier(req);
  if (!verifier) {
    return { ok: false, status: 503, error: "dashboard_api_not_configured" };
  }
  const parsed = await authenticateDashboardCredential(
    req.headers as Record<string, string | undefined>,
    verifier,
    getDashboardSessionCodec(req),
  );
  if (!parsed.ok) {
    return { ok: false, status: parsed.status, error: parsed.message };
  }
  if (!parsed.userId) {
    return { ok: false, status: 401, error: "missing_user" };
  }
  return {
    ok: true,
    userId: parsed.userId,
    workosUserId: parsed.workosUserId,
    userEmail: parsed.userEmail,
  };
};

/**
 * Centralized human-member RBAC gate. Authenticates, then checks the acting
 * member holds `permission` for the resolved workspace. Returns true when the
 * handler should proceed; otherwise it has already sent the error response
 * (401/403/404/503). Used by dashboardGet/dashboardPost for routes that
 * declare a required permission.
 */
export const enforceDashboardPermission = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
  permission: RbacPermissionId,
): Promise<boolean> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) {
    sendJson(res, auth.status, { error: auth.error });
    return false;
  }
  // userId may be absent on legacy reads — decideAuthz allows those only while
  // the workspace is in open mode, and 401s once roles are configured.
  const access = await runWithDb(layer, (db) =>
    getMemberAccess(db, auth.tenantId, auth.userId),
  );
  const decision = decideAuthz(access, auth.userId, permission);
  if (!decision.ok) {
    sendJson(res, decision.status, { error: decision.error });
    return false;
  }
  return true;
};

export type DashboardOrgAuthResult =
  | {
      readonly ok: true;
      readonly organizationId: string;
      readonly userId: string | undefined;
    }
  | { readonly ok: false; readonly status: number; readonly error: string };

/**
 * Auth for the pre-tenant endpoints (`GET /dashboard/tenant`,
 * `POST /dashboard/onboarding`): verify the service token + read the asserted
 * WorkOS org, but do NOT require a tenant (those endpoints exist precisely for
 * the org-without-a-tenant onboarding ticket). Pure — no DB lookup.
 */
export const authenticateDashboardOrg = async (
  _cfg: ApiConfig,
  req: FastifyRequest,
): Promise<DashboardOrgAuthResult> => {
  const verifier = getDashboardVerifier(req);
  if (!verifier) {
    return { ok: false, status: 503, error: "dashboard_api_not_configured" };
  }
  const parsed = await authenticateDashboardCredential(
    req.headers as Record<string, string | undefined>,
    verifier,
    getDashboardSessionCodec(req),
  );
  if (!parsed.ok) {
    return { ok: false, status: parsed.status, error: parsed.message };
  }
  return {
    ok: true,
    organizationId: parsed.organizationId,
    userId: parsed.userId,
  };
};

export const makeLegalAcceptance = (
  acceptedByUserId: string | undefined,
): LegalAcceptance => ({
  dataProcessingNoticeVersion: DATA_PROCESSING_NOTICE_VERSION,
  dpaVersion: DPA_VERSION,
  acceptedAt: new Date().toISOString(),
  acceptedByUserId: acceptedByUserId ?? null,
});

export const tenantHasCurrentLegalAcceptance = (
  tenantId: string,
  layer: ApiLayer,
): Promise<boolean> =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const repo = yield* TenantRepository;
        const settings = yield* repo.getSettings(TenantId(tenantId));
        return legalAcceptanceIsCurrent(settings.legalAcceptance);
      }).pipe(Effect.catchAll(() => Effect.succeed(false))),
      layer,
    ),
  );

export const sendLegalAcceptanceRequired = (res: FastifyReply): FastifyReply =>
  sendJson(res, 403, { error: "legal_acceptance_required" });
