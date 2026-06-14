import { Cause, Effect } from "effect";
import { type FastifyReply, type FastifyRequest } from "fastify";
import {
  ConnectorCredentialStore,
  encrypt,
} from "@support-agent/services";
import { TenantId } from "@support-agent/agent-core";
import {
  listWorkspacesByWorkosOrg,
  tenantDeletionSnapshot,
} from "@support-agent/db";
import { type ApiConfig, type ApiLayer } from "./bootstrap.js";
import { opaqueCause, parseJsonBody, sendJson } from "./platform/http.js";
import {
  authenticateDashboardOrg,
  runWithDb,
} from "./auth/dashboard-context.js";
import { parseAdminAuth } from "./auth/dashboard-auth.js";
import { normalizeShopDomain } from "./features/shopify/install.js";
import { redactShop } from "./compliance-redaction.js";
import { revokeConnectorProviderGrants } from "./dashboard-connect-handlers.js";
import {
  checkAdminShopifyAppPcd,
  getAdminShopifyApp,
  putAdminShopifyApp,
  revokeAdminShopifyApp,
} from "./admin-shopify-app.js";
import {
  getTenantDetailForAdmin,
  listTenantsForAdmin,
} from "./admin-tenants.js";
import {
  getAdminAccountDetail,
  putAdminAccountOpenRouter,
  putAdminWorkspaceOpenRouter,
  revokeAdminAccountOpenRouter,
  revokeAdminWorkspaceOpenRouter,
  type AdminOpenRouterMutationResult,
} from "./admin-openrouter.js";
import {
  buildConnectorGrants,
  makePgBossAccountCleanupPublisher,
  resolveCleanupTargets,
  type AccountCleanupJobData,
  type EncryptedConnectorGrant,
} from "./account-deletion.js";
import {
  makePgBossShopifyPolicyImportPublisher,
  type ShopifyPolicyImportJobData,
} from "./features/shopify/policy-import-queue.js";
import { accountCleanupPublisher } from "./platform/pgboss.js";

// ---- Account deletion (tenant self-service + admin) ----

export type DeleteAccountResult =
  | { readonly kind: "tenant_not_found" }
  // Could not read the tenant's connector grants for revocation, OR could not
  // schedule the cleanup job. Both happen BEFORE the wipe, so NOTHING was
  // deleted — the caller can safely retry (audit re-audit #1c).
  | { readonly kind: "capture_failed" }
  | { readonly kind: "enqueue_failed" }
  | {
      readonly kind: "deleted";
      readonly tenantId: string;
      readonly deletedCases: number;
      readonly deletedAuditRows: number;
      readonly deletedConnectorRows: number;
      readonly workosOrganizationId: string | null;
      readonly cleanupEnqueued: boolean;
    };

/**
 * Shared by the dashboard self-service + admin delete paths. Captures the
 * WorkOS org + notification email, wipes every tenant row (`redactShop`,
 * one tx), then enqueues the cleanup job (WorkOS org delete + deletion
 * email) for the worker. The DB wipe is the critical, atomic step — if the
 * enqueue fails the data is already gone, so we log + report
 * `cleanupEnqueued:false` rather than fail the request (which would falsely
 * imply nothing happened).
 */
/**
 * Capture the tenant's OAuth grants and encrypt their tokens for the cleanup
 * job (audit B1). Must run BEFORE redactShop — once the connector rows are
 * wiped these are unrecoverable.
 *
 * Captures grants in ANY status, not just `active` (re-audit #1a): a locally
 * disconnected/`revoked` row can still have a LIVE provider-side grant that
 * must be revoked. Returns `null` if the rows can't be read — the caller then
 * aborts the deletion WITHOUT wiping (re-audit #1c) so it stays retriable
 * rather than silently dropping revocation and destroying the data anyway.
 */
export const captureConnectorGrants = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  tenantId: string,
): Promise<ReadonlyArray<EncryptedConnectorGrant> | null> => {
  const exit = await Effect.runPromiseExit(
    Effect.provide(
      Effect.gen(function* () {
        const store = yield* ConnectorCredentialStore;
        return yield* store.listForTenant(TenantId(tenantId));
      }),
      layer,
    ),
  );
  if (exit._tag !== "Success") {
    // eslint-disable-next-line no-console
    console.error(
      `[account-delete] tenant=${tenantId} could not read connector grants for revocation:`,
      Cause.pretty(exit.cause),
    );
    return null;
  }
  const enc = (s: string): string =>
    encrypt(cfg.encryptionKey, s).toString("base64");
  return buildConnectorGrants(exit.value, enc);
};

/**
 * Delete a tenant. Ordering is deliberate (re-audit #1c): capture grants →
 * enqueue the cleanup job → THEN wipe. A capture or enqueue failure happens
 * BEFORE the wipe, so nothing is destroyed and the caller can retry. Only once
 * the cleanup (revoke grants + delete WorkOS org + email) is durably queued do
 * we wipe the data. The worker's cleanup will not perform any destructive
 * action until it confirms the tenant rows are actually gone (its deletion
 * gate), so a slow or failed wipe here can never trigger premature revocation
 * / org deletion / email.
 */
export const deleteTenantAccount = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  tenantId: string,
  // Operator identity for the surviving admin-audit record (re-audit #2):
  // "admin" (platform console) or "tenant_self" (dashboard self-service).
  actor: string,
  // Workspace semantics: a single-workspace delete must neither delete the
  // shared WorkOS org nor email the owner; the org is only ever deleted
  // along with its LAST workspace (resolveCleanupTargets).
  opts: { readonly allowOrgDelete: boolean; readonly sendEmail: boolean },
): Promise<DeleteAccountResult> => {
  const snapshot = await runWithDb(layer, (db) =>
    tenantDeletionSnapshot(db, tenantId),
  );
  if (!snapshot) return { kind: "tenant_not_found" };

  const orgWorkspaceCount = snapshot.workosOrganizationId
    ? (
        await runWithDb(layer, (db) =>
          listWorkspacesByWorkosOrg(db, snapshot.workosOrganizationId!),
        )
      ).length
    : 0;
  const targets = resolveCleanupTargets(snapshot, { ...opts, orgWorkspaceCount });

  // 1. Capture provider grants (any status) before anything is destroyed.
  const connectorGrants = await captureConnectorGrants(cfg, layer, tenantId);
  if (connectorGrants === null) return { kind: "capture_failed" };

  // 2. Durably queue the cleanup (revoke + org delete + email) BEFORE the
  //    wipe, so an enqueue failure leaves all data intact and retriable.
  let cleanupJobId: string | null;
  try {
    cleanupJobId = await accountCleanupPublisher(cfg.databaseUrl)({
      tenantId: snapshot.id,
      tenantName: snapshot.name,
      workosOrganizationId: targets.workosOrganizationId,
      notificationEmail: targets.notificationEmail,
      connectorGrants,
    });
  } catch (cause) {
    // eslint-disable-next-line no-console
    console.error(
      `[account-delete] tenant=${tenantId} cleanup enqueue failed (NOT wiped, safe to retry):`,
      cause,
    );
    return { kind: "enqueue_failed" };
  }
  // No job id → the send was suppressed/no-op (e.g. a dedup policy collapsed
  // it onto an existing job that may carry STALE creds). Do NOT wipe — that
  // would destroy the only copy of this attempt's grants (5th-audit #1).
  if (!cleanupJobId) {
    // eslint-disable-next-line no-console
    console.error(
      `[account-delete] tenant=${tenantId} cleanup not queued (no job id); NOT wiping, safe to retry`,
    );
    return { kind: "enqueue_failed" };
  }

  // 3. Wipe every tenant row (atomic), recording a SURVIVING admin-audit
  //    row in the same transaction (re-audit #2).
  const wipe = await Effect.runPromise(
    Effect.provide(
      redactShop(tenantId, {
        action: "tenant.deleted",
        actor,
        details: {
          tenantName: snapshot.name,
          workosOrganizationId: snapshot.workosOrganizationId,
          scope: opts.allowOrgDelete ? "account" : "workspace",
          orgDeleted: targets.workosOrganizationId !== null,
        },
      }),
      layer,
    ),
  );

  return {
    kind: "deleted",
    tenantId,
    deletedCases: wipe.deletedCases,
    deletedAuditRows: wipe.deletedAuditRows,
    deletedConnectorRows: wipe.deletedConnectorRows,
    // The org the cleanup job will actually delete (null when suppressed —
    // workspace-scoped delete, or sibling workspaces still use the org).
    workosOrganizationId: targets.workosOrganizationId,
    cleanupEnqueued: true,
  };
};

// HTTP status for a delete outcome. `capture_failed`/`enqueue_failed` are
// pre-wipe aborts (nothing destroyed) → 503 so the caller retries.
export const deleteResultStatus = (result: DeleteAccountResult): number => {
  switch (result.kind) {
    case "tenant_not_found":
      return 404;
    case "capture_failed":
    case "enqueue_failed":
      return 503;
    case "deleted":
      return 200;
  }
};

// POST /dashboard/account/delete — a manager deletes their WHOLE account:
// every workspace the org owns, newest first so the DEFAULT (oldest) goes
// last and is the only one whose cleanup job deletes the WorkOS org and
// emails the owner. A mid-sweep failure aborts BEFORE that workspace's wipe
// (capture/enqueue precede it), so the remainder — org included — is intact
// and the request is retriable.
export const handleDashboardAccountDelete = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboardOrg(cfg, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const workspaces = await runWithDb(layer, (db) =>
    listWorkspacesByWorkosOrg(db, auth.organizationId),
  );
  if (workspaces.length === 0) {
    return sendJson(res, 403, { error: "no_tenant_for_organization" });
  }
  const order = [...workspaces].reverse(); // default (oldest) last
  let deletedWorkspaces = 0;
  const totals = {
    deletedCases: 0,
    deletedAuditRows: 0,
    deletedConnectorRows: 0,
  };
  let last: Extract<DeleteAccountResult, { kind: "deleted" }> | null = null;
  for (const ws of order) {
    const isFinal = ws === order[order.length - 1];
    const result = await deleteTenantAccount(cfg, layer, ws.id, "tenant_self", {
      allowOrgDelete: true, // suppressed by the last-workspace rule until final
      sendEmail: isFinal,
    });
    // Already gone (another tab won this workspace) — keep sweeping.
    if (result.kind === "tenant_not_found") continue;
    if (result.kind !== "deleted") {
      return sendJson(res, deleteResultStatus(result), {
        ...result,
        deletedWorkspaces,
      });
    }
    deletedWorkspaces += 1;
    totals.deletedCases += result.deletedCases;
    totals.deletedAuditRows += result.deletedAuditRows;
    totals.deletedConnectorRows += result.deletedConnectorRows;
    last = result;
  }
  if (!last) {
    // Everything vanished mid-flight (concurrent delete) — org has no tenant.
    return sendJson(res, 403, { error: "no_tenant_for_organization" });
  }
  return sendJson(res, 200, {
    ...last,
    ...totals,
    deletedWorkspaces,
  });
};

// POST /admin/tenants/:id/delete — platform operator deletes ANY single
// tenant (workspace). The deletion email still goes out; the WorkOS org is
// deleted only when this is the org's last workspace (the last-workspace
// rule in resolveCleanupTargets), so deleting one of two workspaces can't
// kill the sibling's login.
export const handleAdminTenantDelete = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  if (!cfg.adminApiToken) {
    return sendJson(res, 503, { error: "admin_api_not_configured" });
  }
  const parsed = parseAdminAuth(
    req.headers as Record<string, string | undefined>,
    cfg.adminApiToken,
  );
  if (!parsed.ok) return sendJson(res, parsed.status, { error: parsed.message });
  const { id } = req.params as { id: string };
  const result = await deleteTenantAccount(cfg, layer, id, "admin", {
    allowOrgDelete: true,
    sendEmail: true,
  });
  return sendJson(res, deleteResultStatus(result), result);
};

// ---- Admin: per-tenant Shopify custom-app provisioning (pilot) ----

/**
 * Guard the `/admin/tenants/:id/shopify-app` routes: require the configured
 * admin bearer token. Returns the tenant id on success, or `null` after
 * having already sent the error response.
 */
export const adminShopifyAppGuard = (
  cfg: ApiConfig,
  req: FastifyRequest,
  res: FastifyReply,
): string | null => {
  if (!cfg.adminApiToken) {
    sendJson(res, 503, { error: "admin_api_not_configured" });
    return null;
  }
  const parsed = parseAdminAuth(
    req.headers as Record<string, string | undefined>,
    cfg.adminApiToken,
  );
  if (!parsed.ok) {
    sendJson(res, parsed.status, { error: parsed.message });
    return null;
  }
  return (req.params as { id: string }).id;
};

// PUT /admin/tenants/:id/shopify-app — operator sets the tenant's Shopify
// custom-app client_id + client_secret (pilot custom distribution).
export const handleAdminShopifyAppPut = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> => {
  const tenantId = adminShopifyAppGuard(cfg, req, res);
  if (!tenantId) return;
  const body = parseJsonBody(req);
  const clientId = typeof body["clientId"] === "string" ? body["clientId"].trim() : "";
  const clientSecret =
    typeof body["clientSecret"] === "string" ? body["clientSecret"] : "";
  if (!clientId || !clientSecret) {
    sendJson(res, 400, { error: "missing_client_credentials" });
    return;
  }
  // Optional store domain (A4). When given it's normalized + recorded so the
  // install flow can use the standard authorize URL and a no-state callback
  // resolves the tenant. An invalid value is rejected rather than ignored.
  const rawShop =
    typeof body["shopDomain"] === "string" ? body["shopDomain"].trim() : "";
  let shopDomain: string | undefined;
  if (rawShop) {
    const normalized = normalizeShopDomain(rawShop);
    if (!normalized) {
      sendJson(res, 400, { error: "invalid_shop", shop: rawShop });
      return;
    }
    shopDomain = normalized;
  }
  // F1: in pilot mode the store domain is REQUIRED at provisioning. The
  // merchant install flow needs it to build the proven OAuth authorize URL —
  // without it the only fallback is the admin.shopify.com managed-install
  // store picker, whose re-entry needs the global app secret to verify its
  // HMAC, which pure-pilot mode forbids. So an un-installable shop-less row
  // must be refused here rather than created. (SaaS mode keeps it optional.)
  if (cfg.shopifyConnectRequiresProvisioning && !shopDomain) {
    sendJson(res, 400, { error: "shop_domain_required" });
    return;
  }
  const exit = await Effect.runPromiseExit(
    Effect.provide(
      putAdminShopifyApp({
        tenantId,
        clientId,
        clientSecret,
        ...(shopDomain ? { shopDomain } : {}),
      }),
      layer,
    ),
  );
  if (exit._tag !== "Success") {
    sendJson(res, 500, {
      error: "provisioning_failed",
      detail: opaqueCause(exit.cause),
    });
    return;
  }
  if (exit.value.kind === "tenant_not_found") {
    sendJson(res, 404, { error: "tenant_not_found" });
    return;
  }
  if (exit.value.kind === "shop_conflict") {
    sendJson(res, 409, {
      error: "shop_already_connected",
      shop: exit.value.shopDomain,
    });
    return;
  }
  sendJson(res, 200, { ok: true, provisioning: exit.value.provisioning });
};

// GET /admin/tenants/:id/shopify-app — read provisioning status (no secret).
export const handleAdminShopifyAppGet = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> => {
  const tenantId = adminShopifyAppGuard(cfg, req, res);
  if (!tenantId) return;
  const exit = await Effect.runPromiseExit(
    Effect.provide(getAdminShopifyApp(tenantId), layer),
  );
  if (exit._tag !== "Success") {
    sendJson(res, 500, { error: "lookup_failed", detail: opaqueCause(exit.cause) });
    return;
  }
  if (exit.value.kind === "tenant_not_found") {
    sendJson(res, 404, { error: "tenant_not_found" });
    return;
  }
  if (exit.value.kind === "not_provisioned") {
    sendJson(res, 200, { ok: true, provisioned: false, provisioning: null });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    provisioned: true,
    provisioning: exit.value.provisioning,
  });
};

// DELETE /admin/tenants/:id/shopify-app — revoke provisioning (offboarding).
export const handleAdminShopifyAppDelete = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> => {
  const tenantId = adminShopifyAppGuard(cfg, req, res);
  if (!tenantId) return;
  const exit = await Effect.runPromiseExit(
    Effect.provide(revokeAdminShopifyApp(tenantId), layer),
  );
  if (exit._tag !== "Success") {
    sendJson(res, 500, { error: "revoke_failed", detail: opaqueCause(exit.cause) });
    return;
  }
  if (exit.value.kind === "tenant_not_found") {
    sendJson(res, 404, { error: "tenant_not_found" });
    return;
  }
  if (exit.value.kind === "not_provisioned") {
    sendJson(res, 404, { error: "not_provisioned" });
    return;
  }
  // Offboarding the app also revokes the merchant's LIVE Shopify access
  // token provider-side, not just the provisioning row (5th-audit #3).
  const grants = await Effect.runPromise(
    Effect.provide(
      revokeConnectorProviderGrants(TenantId(tenantId), "shopify", tenantId),
      layer,
    ),
  );
  sendJson(res, 200, {
    ok: true,
    provisioning: exit.value.provisioning,
    connectorRevoked: grants.revoked,
    providerRevoked: grants.providerRevoked,
  });
};

// POST /admin/tenants/:id/shopify-app/pcd-check — live protected-customer-data
// probe: read a few recent orders through the tenant's connected store and
// report whether customer PII comes back populated or redacted. Custom
// distribution needs no Shopify review, but the app must still DECLARE its
// PCD fields in the Dev Dashboard or Shopify redacts them on live stores.
export const handleAdminShopifyAppPcdCheck = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> => {
  const tenantId = adminShopifyAppGuard(cfg, req, res);
  if (!tenantId) return;
  const exit = await Effect.runPromiseExit(
    Effect.provide(checkAdminShopifyAppPcd(tenantId), layer),
  );
  if (exit._tag !== "Success") {
    sendJson(res, 502, { error: "pcd_check_failed", detail: opaqueCause(exit.cause) });
    return;
  }
  if (exit.value.kind === "tenant_not_found") {
    sendJson(res, 404, { error: "tenant_not_found" });
    return;
  }
  sendJson(res, 200, { ok: true, result: exit.value });
};

// GET /admin/tenants — list every tenant for the operator admin app.
export const handleAdminTenantsList = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> => {
  if (!cfg.adminApiToken) {
    sendJson(res, 503, { error: "admin_api_not_configured" });
    return;
  }
  const parsed = parseAdminAuth(
    req.headers as Record<string, string | undefined>,
    cfg.adminApiToken,
  );
  if (!parsed.ok) {
    sendJson(res, parsed.status, { error: parsed.message });
    return;
  }
  const exit = await Effect.runPromiseExit(
    Effect.provide(listTenantsForAdmin(), layer),
  );
  if (exit._tag !== "Success") {
    sendJson(res, 500, { error: "list_failed", detail: opaqueCause(exit.cause) });
    return;
  }
  sendJson(res, 200, { tenants: exit.value });
};

// GET /admin/tenants/:id — operator detail for one tenant (no secrets).
export const handleAdminTenantDetail = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> => {
  const tenantId = adminShopifyAppGuard(cfg, req, res);
  if (!tenantId) return;
  const exit = await Effect.runPromiseExit(
    Effect.provide(getTenantDetailForAdmin(tenantId), layer),
  );
  if (exit._tag !== "Success") {
    sendJson(res, 500, { error: "detail_failed", detail: opaqueCause(exit.cause) });
    return;
  }
  if (!exit.value) {
    sendJson(res, 404, { error: "tenant_not_found" });
    return;
  }
  sendJson(res, 200, exit.value);
};

export const adminMutationResponse = (
  res: FastifyReply,
  result: AdminOpenRouterMutationResult,
): void => {
  if (result.kind === "not_found") {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  if (result.kind === "not_configured") {
    sendJson(res, 404, { error: "not_configured" });
    return;
  }
  if (result.kind === "legal_acceptance_required") {
    sendJson(res, 403, { error: "legal_acceptance_required" });
    return;
  }
  sendJson(res, 200, { ok: true });
};

export const adminAuthorized = (
  cfg: ApiConfig,
  req: FastifyRequest,
  res: FastifyReply,
): boolean => {
  if (!cfg.adminApiToken) {
    sendJson(res, 503, { error: "admin_api_not_configured" });
    return false;
  }
  const parsed = parseAdminAuth(
    req.headers as Record<string, string | undefined>,
    cfg.adminApiToken,
  );
  if (!parsed.ok) {
    sendJson(res, parsed.status, { error: parsed.message });
    return false;
  }
  return true;
};

export const handleAdminAccountDetail = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> => {
  if (!adminAuthorized(cfg, req, res)) return;
  const { organizationId } = req.params as { organizationId: string };
  const exit = await Effect.runPromiseExit(
    Effect.provide(getAdminAccountDetail(organizationId), layer),
  );
  if (exit._tag !== "Success") {
    sendJson(res, 500, { error: "detail_failed", detail: opaqueCause(exit.cause) });
    return;
  }
  if (!exit.value) {
    sendJson(res, 404, { error: "account_not_found" });
    return;
  }
  sendJson(res, 200, exit.value);
};

export const handleAdminAccountOpenRouterPut = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> => {
  if (!adminAuthorized(cfg, req, res)) return;
  const { organizationId } = req.params as { organizationId: string };
  const body = parseJsonBody(req);
  const apiKey =
    typeof body["apiKey"] === "string" ? String(body["apiKey"]).trim() : "";
  if (apiKey.length < 8) {
    sendJson(res, 400, { error: "missing_key" });
    return;
  }
  const exit = await Effect.runPromiseExit(
    Effect.provide(putAdminAccountOpenRouter(organizationId, apiKey), layer),
  );
  if (exit._tag !== "Success") {
    sendJson(res, 500, { error: "save_failed", detail: opaqueCause(exit.cause) });
    return;
  }
  adminMutationResponse(res, exit.value);
};

export const handleAdminAccountOpenRouterDelete = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> => {
  if (!adminAuthorized(cfg, req, res)) return;
  const { organizationId } = req.params as { organizationId: string };
  const exit = await Effect.runPromiseExit(
    Effect.provide(revokeAdminAccountOpenRouter(organizationId), layer),
  );
  if (exit._tag !== "Success") {
    sendJson(res, 500, { error: "revoke_failed", detail: opaqueCause(exit.cause) });
    return;
  }
  adminMutationResponse(res, exit.value);
};

export const handleAdminWorkspaceOpenRouterPut = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> => {
  const tenantId = adminShopifyAppGuard(cfg, req, res);
  if (!tenantId) return;
  const body = parseJsonBody(req);
  const apiKey = typeof body["apiKey"] === "string" ? body["apiKey"].trim() : "";
  if (apiKey.length < 8) {
    sendJson(res, 400, { error: "missing_key" });
    return;
  }
  const exit = await Effect.runPromiseExit(
    Effect.provide(putAdminWorkspaceOpenRouter(tenantId, apiKey), layer),
  );
  if (exit._tag !== "Success") {
    sendJson(res, 500, { error: "save_failed", detail: opaqueCause(exit.cause) });
    return;
  }
  adminMutationResponse(res, exit.value);
};

export const handleAdminWorkspaceOpenRouterDelete = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> => {
  const tenantId = adminShopifyAppGuard(cfg, req, res);
  if (!tenantId) return;
  const exit = await Effect.runPromiseExit(
    Effect.provide(revokeAdminWorkspaceOpenRouter(tenantId), layer),
  );
  if (exit._tag !== "Success") {
    sendJson(res, 500, { error: "revoke_failed", detail: opaqueCause(exit.cause) });
    return;
  }
  adminMutationResponse(res, exit.value);
};
