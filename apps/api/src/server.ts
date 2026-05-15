import { Effect } from "effect";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ConnectorCredentialStore } from "@support-agent/services";
import { TenantId } from "@support-agent/agent-core";
import {
  buildInstallUrl,
  isValidShopDomain,
  signState,
  verifyCallbackHmac,
  verifyState,
} from "./shopify-install.js";
import { exchangeCodeForToken } from "./shopify-callback.js";
import { resolveTenantByShop } from "./tenant-resolver.js";
import {
  buildApiLayers,
  loadApiConfig,
  type ApiConfig,
  type ApiLayer,
} from "./bootstrap.js";

// ============================================================
// Helpers
// ============================================================

const readQuery = (
  req: IncomingMessage,
): { url: URL; params: Record<string, string> } => {
  // The Host header is trusted only for *parsing* the path — we never echo
  // it back to the client. For URL construction we use a placeholder that
  // makes `new URL(...)` happy.
  const u = new URL(req.url ?? "/", "http://placeholder");
  const params: Record<string, string> = {};
  for (const [k, v] of u.searchParams) params[k] = v;
  return { url: u, params };
};

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const sendRedirect = (res: ServerResponse, target: string): void => {
  res.writeHead(302, { Location: target });
  res.end();
};

const sendText = (res: ServerResponse, status: number, body: string): void => {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
};

// ============================================================
// Route handlers
// ============================================================

/**
 * GET /shopify/install?shop=<shop>.myshopify.com&tenant=<uuid>
 *
 * Starts the managed-install OAuth flow. We sign the tenant id into the
 * OAuth `state` parameter so the callback can recover it and bind the
 * resulting access token to the right tenant.
 */
const handleShopifyInstall = (
  cfg: ApiConfig,
  req: IncomingMessage,
  res: ServerResponse,
): void => {
  const { params } = readQuery(req);
  const shop = params["shop"];
  const tenant = params["tenant"];
  if (!shop || !isValidShopDomain(shop)) {
    sendJson(res, 400, { error: "missing_or_invalid_shop" });
    return;
  }
  if (!tenant) {
    sendJson(res, 400, { error: "missing_tenant" });
    return;
  }
  const state = signState(cfg.stateSigningKey, tenant);
  const installUrl = buildInstallUrl({
    shop,
    clientId: cfg.shopify.clientId,
    scopes: cfg.shopify.scopes,
    redirectUri: cfg.shopify.callbackUrl,
    state,
  });
  sendRedirect(res, installUrl);
};

/**
 * GET /shopify/auth/callback?code&hmac&shop[&state][&host&timestamp]
 *
 * Two install paths funnel through here:
 *
 *   1. Dashboard-initiated — merchant first hit `/shopify/install?tenant=...`,
 *      we signed `tenant` into `state`, Shopify echoed it back. We recover
 *      the tenantId from the signed state.
 *
 *   2. Shopify Custom Distribution — merchant clicked the Partner Dashboard
 *      install link. Shopify drove the OAuth flow directly, so we don't
 *      see the merchant before the callback and there's no `state` of our
 *      design. We look up (or auto-create) a tenant for this shop via
 *      `resolveTenantByShop`, gated on the partial unique index on
 *      `tenants.shopify_domain`.
 *
 * HMAC is always verified. If `state` is present but doesn't verify, we
 * reject with 401 (tampered) — we never silently fall back to shop
 * resolution in that case.
 */
const handleShopifyCallback = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> => {
  const { params } = readQuery(req);
  const shop = params["shop"];
  const code = params["code"];
  const state = params["state"];
  const hmac = params["hmac"];

  if (!shop || !isValidShopDomain(shop)) {
    sendJson(res, 400, { error: "invalid_shop" });
    return;
  }
  if (!code || !hmac) {
    sendJson(res, 400, { error: "missing_required_param" });
    return;
  }
  const hmacOk = verifyCallbackHmac({
    clientSecret: cfg.shopify.clientSecret,
    query: params,
    receivedHmac: hmac,
  });
  if (!hmacOk) {
    sendJson(res, 401, { error: "hmac_verification_failed" });
    return;
  }

  let tenantId: string | null = null;
  if (state) {
    const decoded = verifyState(cfg.stateSigningKey, state);
    if (!decoded) {
      sendJson(res, 401, { error: "state_verification_failed" });
      return;
    }
    tenantId = decoded.tenantId;
  }

  if (!tenantId) {
    const resolveExit = await Effect.runPromiseExit(
      Effect.provide(resolveTenantByShop(shop), layer),
    );
    if (resolveExit._tag !== "Success") {
      sendJson(res, 500, {
        error: "tenant_resolve_failed",
        detail: String(resolveExit.cause),
      });
      return;
    }
    tenantId = resolveExit.value;
  }

  let token: { accessToken: string; scope: ReadonlyArray<string> };
  try {
    token = await exchangeCodeForToken({
      shop,
      clientId: cfg.shopify.clientId,
      clientSecret: cfg.shopify.clientSecret,
      code,
    });
  } catch (cause) {
    sendJson(res, 502, {
      error: "token_exchange_failed",
      detail: cause instanceof Error ? cause.message : String(cause),
    });
    return;
  }

  const putExit = await Effect.runPromiseExit(
    Effect.provide(
      Effect.gen(function* () {
        const store = yield* ConnectorCredentialStore;
        return yield* store.put({
          tenantId: TenantId(tenantId),
          provider: "shopify",
          shopDomain: shop,
          accessToken: token.accessToken,
          scopes: token.scope,
          apiVersion: cfg.shopify.apiVersion,
        });
      }),
      layer,
    ),
  );

  if (putExit._tag !== "Success") {
    sendJson(res, 500, {
      error: "persist_failed",
      detail: String(putExit.cause),
    });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    tenantId,
    shop,
    scopes: token.scope,
  });
};

// ============================================================
// Server
// ============================================================

export interface ServerHandle {
  readonly close: () => Promise<void>;
  readonly port: number;
}

export const startServer = async (
  cfg: ApiConfig,
): Promise<ServerHandle> => {
  const layer = buildApiLayers(cfg);

  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";
    void (async () => {
      try {
        if (method === "GET" && url.startsWith("/shopify/install")) {
          handleShopifyInstall(cfg, req, res);
          return;
        }
        if (method === "GET" && url.startsWith("/shopify/auth/callback")) {
          await handleShopifyCallback(cfg, layer, req, res);
          return;
        }
        if (method === "GET" && url === "/healthz") {
          sendText(res, 200, "ok");
          return;
        }
        sendJson(res, 404, { error: "not_found" });
      } catch (cause) {
        // eslint-disable-next-line no-console
        console.error("[api] unhandled error:", cause);
        sendJson(res, 500, { error: "internal" });
      }
    })();
  });

  return new Promise((resolve) => {
    server.listen(cfg.port, () => {
      const address = server.address();
      const port =
        address && typeof address === "object" ? address.port : cfg.port;
      // eslint-disable-next-line no-console
      console.log(`[api] listening on http://localhost:${port}`);
      resolve({
        port,
        close: () =>
          new Promise<void>((res) =>
            server.close(() => {
              res();
            }),
          ),
      });
    });
  });
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
const invokedDirectly = process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js");
if (invokedDirectly) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[api] failed to start:", err);
    process.exit(1);
  });
}
