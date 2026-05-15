import { Effect, Layer } from "effect";
import {
  ConnectorCredentialStore,
  parseKey,
} from "@support-agent/services";
import {
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
  readonly scopes: ReadonlyArray<string>;
  readonly callbackUrl: string;
  readonly apiVersion: string;
}

export interface ApiConfig {
  readonly port: number;
  readonly databaseUrl: string;
  readonly encryptionKey: Buffer;
  readonly stateSigningKey: string;
  readonly shopify: ShopifyAppConfig;
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
  return {
    port: Number(process.env["API_PORT"] ?? 4000),
    databaseUrl: requireEnv("DATABASE_URL"),
    encryptionKey: parseKey(requireEnv("CREDENTIAL_ENCRYPTION_KEY")),
    stateSigningKey: requireEnv("STATE_SIGNING_KEY"),
    shopify: {
      clientId: requireEnv("SHOPIFY_APP_CLIENT_ID"),
      clientSecret: requireEnv("SHOPIFY_APP_CLIENT_SECRET"),
      scopes: requireEnv("SHOPIFY_APP_SCOPES")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      callbackUrl,
      apiVersion: process.env["SHOPIFY_API_VERSION"] ?? "2026-04",
    },
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
  // Expose both layers so request handlers can yield ConnectorCredentialStore
  // and (if needed later) DbClient directly.
  return Layer.mergeAll(store, dbLayer);
};

export type ApiLayer = Layer.Layer<
  ConnectorCredentialStore | DbClient,
  never,
  never
>;
