import { Effect, Layer } from "effect";
import {
  ApprovalService,
  BlobStorage,
  BlobStorageTest,
  ConnectorCredentialStore,
  parseKey,
  TransactionRunner,
} from "@support-agent/services";
import {
  ApprovalServiceLive,
  ConnectorCredentialStoreLive,
  DbClient,
  DbClientLive,
  TransactionRunnerLive,
} from "@support-agent/db";
import {
  BlobStorageConfigFromEnv,
  BlobStorageLive,
} from "@support-agent/providers";

// ============================================================
// Env validation
// ============================================================

export interface ShopifyAppConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly callbackUrl: string;
  readonly apiVersion: string;
}

/**
 * The scope set our runtime expects the merchant to grant. This is
 * NOT what we request at install time — that lives in the Shopify
 * Partner Dashboard ("Required access scopes"), which is the binding
 * source of truth. When you edit the dashboard config, Shopify
 * auto-prompts existing merchants to update permissions on their next
 * visit; we don't need to coordinate a "go reinstall" message.
 *
 * This list serves two read-only purposes in code:
 *   1. The integrations page renders it as a capability grid against
 *      `connector_connections.scopes` (the actually-granted set,
 *      returned in the OAuth callback). Lets the operator see at a
 *      glance whether the merchant has granted enough access.
 *   2. Documentation for which tool needs which scope:
 *      - `read_orders`      → shopify.get_order, shopify.findOrderByName
 *      - `read_customers`   → shopify.get_customer, shopify.searchByEmail
 *      - `read_products`    → shopify.get_product (damaged-product photo
 *                             cross-check)
 *      - `write_orders`     → refund.create (and future order-edit tools)
 *
 * Keep aligned with the Partner Dashboard config AND `shopify.app.toml`.
 * The `shopify-tool-scopes` test asserts every Shopify tool's
 * `requiredConnectorScopes` is covered here, so a new scoped tool can't
 * silently outrun the requested scopes.
 */
export const DEFAULT_SHOPIFY_SCOPES: ReadonlyArray<string> = [
  "read_orders",
  "read_customers",
  "read_products",
  "write_orders",
];

export interface GoogleAppConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly callbackUrl: string;
  /**
   * Fully-qualified Pub/Sub topic the Gmail watch publishes to, e.g.
   * `projects/<gcp-project>/topics/gmail-inbox`. Null when Google OAuth is
   * configured for non-Gmail connectors only.
   */
  readonly pubsubTopic: string | null;
  /**
   * Shared secret the Pub/Sub push subscription must include in the
   * webhook URL query (`?token=…`). Without this, anyone hitting our
   * `/webhooks/conversations/gmail` endpoint can replay
   * mailbox-update notifications. Generate with `randomBytes(32).hex`.
   */
  readonly pushToken: string | null;
}

export interface ApiConfig {
  readonly port: number;
  readonly databaseUrl: string;
  readonly encryptionKey: Buffer;
  readonly stateSigningKey: string;
  readonly shopify: ShopifyAppConfig;
  /**
   * `null` when Google OAuth env vars are unset — the API still boots and
   * Shopify routes work; `/google/*` responds 503 in that case. Gmail
   * webhooks additionally require `GMAIL_PUSH_TOKEN`.
   */
  readonly google: GoogleAppConfig | null;
  /**
   * Shared HMAC secret for approval-link tokens. Verifies the signed
   * `?token=...` on `/approvals/:id/approve|reject` URLs. MUST be the
   * same value the worker uses to sign tokens (APPROVAL_SIGNING_KEY env
   * in apps/worker). Required even when no approvals are yet in flight —
   * the worker may have already mailed live links before this restart.
   */
  readonly approvalSigningKey: string;
  /**
   * Public origin of the dashboard (`apps/dashboard`), e.g.
   * `https://app.example.com`. When set, a successful connector OAuth
   * callback redirects the merchant back to the dashboard's
   * `/settings/integrations` page (landing them inside our own app, the
   * way Claude returns you to its connectors page) instead of the
   * standalone `/installed` landing page. `null` → keep the `/installed`
   * fallback. May carry a path prefix.
   */
  readonly dashboardBaseUrl: string | null;
  /**
   * Shared service token the dashboard (Cloudflare Worker) presents as
   * `Authorization: Bearer <token>` when calling the `/dashboard/*` read
   * API (Path B). `null` → those routes respond 503 (not configured).
   * The dashboard does the WorkOS user auth and asserts its `x-org-id`;
   * the api trusts this token and maps org → tenant.
   */
  readonly dashboardApiToken: string | null;
}

const requireEnv = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
};

export const loadApiConfig = (): ApiConfig => {
  const callbackUrl = requireEnv("SHOPIFY_APP_CALLBACK_URL");
  // Shopify rejects non-https callback URLs (including http://localhost)
  // at registration time. Failing here gives a clearer error than letting
  // the bad URL surface as a Partner Dashboard validation error or, worse,
  // a confusing OAuth failure mid-flow. Tests use http:// against an
  // ephemeral local server and set NODE_ENV=test (or skip this check via
  // ALLOW_HTTP_CALLBACK=1 for any other local need).
  const allowHttp =
    process.env["NODE_ENV"] === "test" ||
    process.env["ALLOW_HTTP_CALLBACK"] === "1";
  if (!callbackUrl.startsWith("https://") && !allowHttp) {
    throw new Error(
      `SHOPIFY_APP_CALLBACK_URL must use https:// (got ${callbackUrl}). Expose apps/api through the Cloudflare Tunnel in cloudflared/ or set ALLOW_HTTP_CALLBACK=1 for a non-Shopify local test.`,
    );
  }
  const googleClientId = process.env["GOOGLE_OAUTH_CLIENT_ID"];
  const googleClientSecret = process.env["GOOGLE_OAUTH_CLIENT_SECRET"];
  const googleCallbackUrl = process.env["GOOGLE_OAUTH_CALLBACK_URL"];
  const googlePubsubTopic = process.env["GMAIL_PUBSUB_TOPIC"];
  const googlePushToken = process.env["GMAIL_PUSH_TOKEN"];
  const googleConfigured =
    !!googleClientId && !!googleClientSecret && !!googleCallbackUrl;
  if (googleConfigured && !googleCallbackUrl.startsWith("https://") && !allowHttp) {
    throw new Error(
      `GOOGLE_OAUTH_CALLBACK_URL must use https:// (got ${googleCallbackUrl}). Google rejects http callbacks except for http://localhost loopback installs.`,
    );
  }
  return {
    port: Number(process.env["API_PORT"] ?? 4000),
    databaseUrl: requireEnv("DATABASE_URL"),
    encryptionKey: parseKey(requireEnv("CREDENTIAL_ENCRYPTION_KEY")),
    stateSigningKey: requireEnv("STATE_SIGNING_KEY"),
    shopify: {
      clientId: requireEnv("SHOPIFY_APP_CLIENT_ID"),
      clientSecret: requireEnv("SHOPIFY_APP_CLIENT_SECRET"),
      callbackUrl,
      apiVersion: process.env["SHOPIFY_API_VERSION"] ?? "2026-04",
    },
    approvalSigningKey: requireEnv("APPROVAL_SIGNING_KEY"),
    dashboardBaseUrl: process.env["DASHBOARD_BASE_URL"]?.trim() || null,
    dashboardApiToken: process.env["DASHBOARD_API_TOKEN"]?.trim() || null,
    google: googleConfigured
      ? {
          clientId: googleClientId,
          clientSecret: googleClientSecret,
          callbackUrl: googleCallbackUrl,
          pubsubTopic: googlePubsubTopic ?? null,
          pushToken: googlePushToken ?? null,
        }
      : null,
  };
};

// ============================================================
// Layers
// ============================================================

export const buildApiLayers = (cfg: ApiConfig) => {
  const dbLayer = DbClientLive({ databaseUrl: cfg.databaseUrl });
  const store = ConnectorCredentialStoreLive(cfg.encryptionKey).pipe(
    Layer.provide(dbLayer),
  );
  // ApprovalServiceLive lets `/approvals/:id/approve|reject` mark the
  // row decided in the same Live impl the runtime uses to create them.
  const approvals = ApprovalServiceLive.pipe(Layer.provide(dbLayer));
  const tx = TransactionRunnerLive.pipe(Layer.provide(dbLayer));
  // BlobStorage: Live over R2 when R2_* env is set (Gmail webhook
  // uploads image attachments here so the runtime / LLM can read them
  // back); in-memory Test layer otherwise — dev + integration tests
  // that exercise the webhook without R2 still work, they just store
  // bytes in process memory.
  const blob = process.env["R2_BUCKET"]
    ? BlobStorageLive.pipe(Layer.provide(BlobStorageConfigFromEnv))
    : BlobStorageTest({});
  return Layer.mergeAll(store, approvals, tx, dbLayer, blob);
};

export type ApiLayer = Layer.Layer<
  | ConnectorCredentialStore
  | ApprovalService
  | TransactionRunner
  | DbClient
  | BlobStorage,
  never,
  never
>;
