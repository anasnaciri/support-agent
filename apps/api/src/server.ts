import {
  buildApiLayers,
  loadApiConfig,
  type ApiConfig,
} from "./bootstrap.js";
import {
  makeRemoteWorkosVerifier,
  type DashboardTokenVerifier,
} from "./auth/dashboard-jwt.js";
import {
  makeWorkosOrgAdminDirectory,
  makeWorkosOrganizationDirectory,
  makeWorkosUserDirectory,
  type WorkosOrgAdminDirectory,
  type WorkosOrganizationDirectory,
  type WorkosUserDirectory,
} from "./auth/workos-directory.js";
import {
  makeSessionCodec,
  type SessionCodec,
} from "./auth/dashboard-session.js";
import { registerDashboardAuthRoutes } from "./auth/dashboard-auth-routes.js";
import { buildApp } from "./platform/app.js";
import type { RouteContext } from "./platform/context.js";
import { stopApprovalBoss } from "./platform/pgboss.js";
import { registerShopifyRoutes } from "./features/shopify/routes.js";
import { registerMailboxRoutes } from "./features/mailbox/routes.js";
import { registerTelegramRoutes } from "./features/telegram/routes.js";
import { registerApprovalRoutes } from "./features/approvals/routes.js";
import { registerDashboardRoutes } from "./features/dashboard/routes.js";
import { registerMemberRoutes } from "./features/members/routes.js";
import { registerFulfillmentOperatorRoutes } from "./features/fulfillment-operators/routes.js";
import { registerAdminRoutes } from "./features/admin/routes.js";
import { registerSystemRoutes } from "./features/system/routes.js";
import { registerShipmentRoutes } from "./features/shipments/routes.js";

// Re-exported for query-params.test.ts, which exercises this query helper.
export { strList } from "./platform/http.js";

// ============================================================
// Server — composition root
// ============================================================
//
// server.ts builds the app, wires per-feature route modules, and owns process
// lifecycle. Cross-cutting setup (logging, security headers, OpenAPI, the
// raw-body parser, error/404 handlers) lives in ./platform/app.ts; each route
// table lives next to its handlers in src/features/<x>/routes.ts and is mounted
// here via register*Routes(app, ctx).

export interface ServerHandle {
  readonly close: () => Promise<void>;
  readonly port: number;
}

export interface StartServerOptions {
  /**
   * Override the WorkOS access-token verifier. Production leaves this unset and
   * a JWKS-backed verifier is built from `cfg.workos`; integration tests inject
   * a static verifier so they can drive the resolved org/user without minting
   * real RS256 JWTs.
   */
  readonly dashboardTokenVerifier?: DashboardTokenVerifier;
  /**
   * Override the WorkOS user directory (verified-email lookup). Production
   * builds it from `cfg.workos.apiKey`; tests inject a static map so invite
   * reconcile can resolve a member's verified email without a WorkOS call.
   */
  readonly workosUserDirectory?: WorkosUserDirectory;
  /**
   * Override the WorkOS organization directory (org-name lookup). Production
   * builds it from `cfg.workos.apiKey`; the admin console uses it to show an
   * org's display name beside its id. Tests inject a static map.
   */
  readonly workosOrganizationDirectory?: WorkosOrganizationDirectory;
  /**
   * Override the WorkOS org-admin directory (create org / add member / list
   * memberships / send invitation). Production builds it from
   * `cfg.workos.apiKey`; the SPA onboarding + invite-send paths use it so the
   * browser never holds `WORKOS_API_KEY`. Tests inject a static impl.
   */
  readonly workosOrgAdminDirectory?: WorkosOrgAdminDirectory;
  /**
   * Override the SPA BFF session codec. Production builds it from
   * `cfg.dashboardBff.sessionPassword`; tests inject one so they can seal a
   * cookie and exercise the cookie-credential path.
   */
  readonly dashboardSessionCodec?: SessionCodec;
  /**
   * Override the WorkOS OAuth HTTP calls used by `/dashboard/auth/*` (code
   * exchange + refresh). Production uses global fetch; tests inject a fake.
   */
  readonly workosOAuthFetch?: typeof fetch;
}

export const startServer = async (
  cfg: ApiConfig,
  opts: StartServerOptions = {},
): Promise<ServerHandle> => {
  const layer = buildApiLayers(cfg);

  // S14: the dashboard forwards the merchant's WorkOS access token; the api
  // verifies it against WorkOS's client-scoped JWKS. Built once at boot
  // (createRemoteJWKSet is lazy) and read off `req.server` by the auth seam.
  // `null` when WorkOS isn't configured → `/dashboard/*` responds 503.
  const dashboardTokenVerifier: DashboardTokenVerifier | null =
    opts.dashboardTokenVerifier ??
    (cfg.workos
      ? makeRemoteWorkosVerifier(
          cfg.workos.jwksUrl,
          cfg.workos.issuer ? { issuer: cfg.workos.issuer } : {},
        )
      : null);

  // Verified-email lookup for invite reconcile (closes the x-user-email spoof).
  // `null` when WORKOS_API_KEY is unset → reconcile is a no-op, never falls back
  // to the header.
  const workosUserDirectory: WorkosUserDirectory | null =
    opts.workosUserDirectory ??
    (cfg.workos?.apiKey ? makeWorkosUserDirectory(cfg.workos.apiKey) : null);

  // Org-name lookup for the admin console (name beside the org id). Same key,
  // same soft-fail contract as the user directory; `null` → show just the id.
  const workosOrganizationDirectory: WorkosOrganizationDirectory | null =
    opts.workosOrganizationDirectory ??
    (cfg.workos?.apiKey
      ? makeWorkosOrganizationDirectory(cfg.workos.apiKey)
      : null);

  // Org-admin (WRITE) directory — org provisioning + server-side invitations for
  // the SPA. Same key + soft-fail contract; `null` → no `WORKOS_API_KEY`, so the
  // SPA onboarding + invite-send paths respond 503 (the Next bearer path is
  // unaffected because it still mints invitations client-side).
  const workosOrgAdminDirectory: WorkosOrgAdminDirectory | null =
    opts.workosOrgAdminDirectory ??
    (cfg.workos?.apiKey
      ? makeWorkosOrgAdminDirectory(cfg.workos.apiKey)
      : null);

  // SPA BFF session codec — seals/unseals the httpOnly cookie. `null` unless the
  // BFF is configured (API_SESSION_PASSWORD). The credential seam + auth routes
  // read it off `req.server`.
  const dashboardSessionCodec: SessionCodec | null =
    opts.dashboardSessionCodec ??
    (cfg.dashboardBff
      ? makeSessionCodec(cfg.dashboardBff.sessionPassword)
      : null);

  const app = await buildApp({
    dashboardTokenVerifier,
    workosUserDirectory,
    workosOrganizationDirectory,
    workosOrgAdminDirectory,
    dashboardSessionCodec,
    dashboardBffOrigins: cfg.dashboardBff?.spaOrigins ?? [],
  });

  const ctx: RouteContext = { cfg, layer };
  registerDashboardAuthRoutes(
    app,
    ctx,
    opts.workosOAuthFetch ? { workosFetch: opts.workosOAuthFetch } : {},
  );
  registerShopifyRoutes(app, ctx);
  registerShipmentRoutes(app, ctx);
  registerMailboxRoutes(app, ctx);
  registerTelegramRoutes(app, ctx);
  registerApprovalRoutes(app, ctx);
  registerDashboardRoutes(app, ctx);
  registerMemberRoutes(app, ctx);
  registerFulfillmentOperatorRoutes(app, ctx);
  registerAdminRoutes(app, ctx);
  registerSystemRoutes(app, ctx);

  await app.listen({ port: cfg.port, host: process.env["API_HOST"] ?? "0.0.0.0" });
  const address = app.server.address();
  const port = address && typeof address === "object" ? address.port : cfg.port;
  app.log.info(`[api] listening on http://localhost:${port}`);
  return {
    port,
    close: async () => {
      await app.close();
      // Stop the shared approval pg-boss (started lazily on the first
      // approval decision) so shutdown / tests don't leak its connection, and
      // drop the memoized publishers so a fresh server re-ensures the queue.
      await stopApprovalBoss();
    },
  };
};

// ============================================================
// Entrypoint
// ============================================================

const main = async () => {
  const cfg = loadApiConfig();
  const handle = await startServer(cfg);
  const shutdown = async () => {
    await handle.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};

// Only run the entrypoint when invoked directly (e.g. `tsx src/server.ts`),
// not when imported by tests.
const invokedDirectly =
  process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js");
if (invokedDirectly) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[api] failed to start:", err);
    process.exit(1);
  });
}
