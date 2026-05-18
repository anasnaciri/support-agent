import { Effect, Layer } from "effect";
import {
  ApprovalService,
  ConnectorCredentialStore,
  parseKey,
} from "@support-agent/services";
import {
  ApprovalServiceLive,
  ConnectorCredentialStoreLive,
  DbClient,
  DbClientLive,
} from "@support-agent/db";

// ============================================================
// Env validation
// ============================================================

export interface ShopifyAppConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly callbackUrl: string;
  readonly apiVersion: string;
}

export interface GoogleAppConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly callbackUrl: string;
  /**
   * Fully-qualified Pub/Sub topic the Gmail watch publishes to, e.g.
   * `projects/<gcp-project>/topics/gmail-inbox`. Required at install time
   * because the OAuth callback registers a `users.watch` on this topic.
   */
  readonly pubsubTopic: string;
  /**
   * Shared secret the Pub/Sub push subscription must include in the
   * webhook URL query (`?token=…`). Without this, anyone hitting our
   * `/webhooks/conversations/gmail/:tenantId` endpoint can replay
   * mailbox-update notifications. Generate with `randomBytes(32).hex`.
   */
  readonly pushToken: string;
}

export interface ApiConfig {
  readonly port: number;
  readonly databaseUrl: string;
  readonly encryptionKey: Buffer;
  readonly stateSigningKey: string;
  readonly shopify: ShopifyAppConfig;
  /**
   * `null` when Google OAuth env vars are unset — the API still boots and
   * Shopify routes work; `/google/*` and `/webhooks/conversations/gmail/*`
   * respond 503 in that case. Dev convenience: a single-tenant dev box
   * doesn't have to provision Google credentials to test Shopify.
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
    !!googleClientId &&
    !!googleClientSecret &&
    !!googleCallbackUrl &&
    !!googlePubsubTopic &&
    !!googlePushToken;
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
    google: googleConfigured
      ? {
          clientId: googleClientId,
          clientSecret: googleClientSecret,
          callbackUrl: googleCallbackUrl,
          pubsubTopic: googlePubsubTopic,
          pushToken: googlePushToken,
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
  return Layer.mergeAll(store, approvals, dbLayer);
};

export type ApiLayer = Layer.Layer<
  ConnectorCredentialStore | ApprovalService | DbClient,
  never,
  never
>;
