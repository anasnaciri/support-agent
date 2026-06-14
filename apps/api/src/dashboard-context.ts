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
  type DrizzleDb,
} from "@support-agent/db";
import { type RbacPermissionId } from "@support-agent/dashboard-contracts";
import { decideAuthz } from "./dashboard-authz.js";
import {
  authenticateDashboardToken,
  isWorkspaceIdShape,
} from "./dashboard-auth.js";
import { type DashboardTokenVerifier } from "./dashboard-jwt.js";
import { type WorkosUserDirectory } from "./workos-directory.js";
import { type ApiConfig, type ApiLayer } from "./bootstrap.js";
import { sendJson } from "./http.js";

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

export const resolveDashboardAuth = async (
  layer: ApiLayer,
  req: FastifyRequest,
): Promise<DashboardAuthResult> => {
  const verifier = getDashboardVerifier(req);
  if (!verifier) {
    return { ok: false, status: 503, error: "dashboard_api_not_configured" };
  }
  const parsed = await authenticateDashboardToken(
    req.headers as Record<string, string | undefined>,
    verifier,
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
 * the org-without-a-tenant onboarding case). Pure — no DB lookup.
 */
export const authenticateDashboardOrg = async (
  _cfg: ApiConfig,
  req: FastifyRequest,
): Promise<DashboardOrgAuthResult> => {
  const verifier = getDashboardVerifier(req);
  if (!verifier) {
    return { ok: false, status: 503, error: "dashboard_api_not_configured" };
  }
  const parsed = await authenticateDashboardToken(
    req.headers as Record<string, string | undefined>,
    verifier,
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
