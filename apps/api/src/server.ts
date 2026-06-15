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
  makeWorkosUserDirectory,
  type WorkosUserDirectory,
} from "./auth/workos-directory.js";
import { buildApp } from "./platform/app.js";
import type { RouteContext } from "./platform/context.js";
import { stopApprovalBoss } from "./platform/pgboss.js";
import { registerShopifyRoutes } from "./features/shopify/routes.js";
import { registerMailboxRoutes } from "./features/mailbox/routes.js";
import { registerTelegramRoutes } from "./features/telegram/routes.js";
import { registerApprovalRoutes } from "./features/approvals/routes.js";
import { registerDashboardRoutes } from "./features/dashboard/routes.js";
import { registerMemberRoutes } from "./features/members/routes.js";
import { registerSupplierRoutes } from "./features/suppliers/routes.js";
import { registerAdminRoutes } from "./features/admin/routes.js";
import { registerSystemRoutes } from "./features/system/routes.js";

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

  const app = await buildApp({ dashboardTokenVerifier, workosUserDirectory });

  const ctx: RouteContext = { cfg, layer };
  registerShopifyRoutes(app, ctx);
  registerMailboxRoutes(app, ctx);
  registerTelegramRoutes(app, ctx);
  registerApprovalRoutes(app, ctx);
  registerDashboardRoutes(app, ctx);
  registerMemberRoutes(app, ctx);
  registerSupplierRoutes(app, ctx);
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
