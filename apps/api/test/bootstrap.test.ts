import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SHOPIFY_SCOPES, loadApiConfig } from "../src/bootstrap.js";

describe("DEFAULT_SHOPIFY_SCOPES", () => {
  // Must cover every scope a Shopify-backed tool declares in its
  // `requiredConnectorScopes`, or the managed install won't request enough
  // access and the tool gets denied at runtime. read_products was added
  // when shopify.get_product joined the damaged-product flow. Keep aligned
  // with shopify.app.toml + the Partner Dashboard.
  it("includes every scope the Shopify tools require", () => {
    for (const scope of [
      "read_orders", // shopify.get_order / findOrderByName
      "read_customers", // shopify.get_customer / searchByEmail
      "read_products", // shopify.get_product
      "write_orders", // refund.create
    ]) {
      expect(DEFAULT_SHOPIFY_SCOPES).toContain(scope);
    }
  });
});

const setEnv = (vars: Record<string, string>) => {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
};

const baseEnv = (overrides: Record<string, string> = {}) => ({
  DATABASE_URL: "postgres://x@y/z",
  CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  STATE_SIGNING_KEY: "state-key",
  APPROVAL_SIGNING_KEY: "approval-key",
  SHOPIFY_APP_CLIENT_ID: "cid",
  SHOPIFY_APP_CLIENT_SECRET: "cs",
  SHOPIFY_APP_CALLBACK_URL:
    "https://support-agent-api.nacirianas.com/shopify/auth/callback",
  ...overrides,
});

describe("loadApiConfig — HTTPS callback enforcement", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    if (restore) {
      restore();
      restore = null;
    }
  });

  it("accepts an https callback URL", () => {
    restore = setEnv({
      NODE_ENV: "production",
      ALLOW_HTTP_CALLBACK: "",
      ...baseEnv(),
    });
    const cfg = loadApiConfig();
    expect(cfg.shopify.callbackUrl).toBe(
      "https://support-agent-api.nacirianas.com/shopify/auth/callback",
    );
  });

  it("rejects an http callback URL in non-test environments", () => {
    restore = setEnv({
      NODE_ENV: "production",
      ALLOW_HTTP_CALLBACK: "",
      ...baseEnv({
        SHOPIFY_APP_CALLBACK_URL: "http://localhost:4000/shopify/auth/callback",
      }),
    });
    expect(() => loadApiConfig()).toThrow(/must use https/);
  });

  it("allows http when NODE_ENV=test (used by the integration test)", () => {
    restore = setEnv({
      NODE_ENV: "test",
      ALLOW_HTTP_CALLBACK: "",
      ...baseEnv({
        SHOPIFY_APP_CALLBACK_URL: "http://localhost/shopify/auth/callback",
      }),
    });
    const cfg = loadApiConfig();
    expect(cfg.shopify.callbackUrl).toBe(
      "http://localhost/shopify/auth/callback",
    );
  });

  it("allows http when ALLOW_HTTP_CALLBACK=1 is set explicitly", () => {
    restore = setEnv({
      NODE_ENV: "production",
      ALLOW_HTTP_CALLBACK: "1",
      ...baseEnv({
        SHOPIFY_APP_CALLBACK_URL: "http://example.test/cb",
      }),
    });
    const cfg = loadApiConfig();
    expect(cfg.shopify.callbackUrl).toBe("http://example.test/cb");
  });

  it("threads DASHBOARD_BASE_URL into config, null when unset", () => {
    restore = setEnv({
      NODE_ENV: "production",
      ALLOW_HTTP_CALLBACK: "",
      DASHBOARD_BASE_URL: "https://app.example.com",
      ...baseEnv(),
    });
    expect(loadApiConfig().dashboardBaseUrl).toBe("https://app.example.com");
    restore();
    restore = setEnv({
      NODE_ENV: "production",
      ALLOW_HTTP_CALLBACK: "",
      DASHBOARD_BASE_URL: "",
      ...baseEnv(),
    });
    expect(loadApiConfig().dashboardBaseUrl).toBeNull();
  });

  it("enables Google OAuth without requiring Gmail Pub/Sub env", () => {
    restore = setEnv({
      NODE_ENV: "production",
      ALLOW_HTTP_CALLBACK: "",
      ...baseEnv({
        GOOGLE_OAUTH_CLIENT_ID: "google-cid",
        GOOGLE_OAUTH_CLIENT_SECRET: "google-secret",
        GOOGLE_OAUTH_CALLBACK_URL:
          "https://support-agent-api.nacirianas.com/google/auth/callback",
      }),
    });
    const cfg = loadApiConfig();
    expect(cfg.google).toEqual({
      clientId: "google-cid",
      clientSecret: "google-secret",
      callbackUrl:
        "https://support-agent-api.nacirianas.com/google/auth/callback",
      pubsubTopic: null,
      pushToken: null,
    });
  });

  // A6 — pilot mode is pure per-tenant provisioning: it ships NO global app,
  // and global creds are disallowed (not merely optional).
  it("boots with no global Shopify creds when provisioning is required (pilot)", () => {
    restore = setEnv({
      NODE_ENV: "test",
      ALLOW_HTTP_CALLBACK: "",
      SHOPIFY_CONNECT_REQUIRES_PROVISIONING: "true",
      ...baseEnv({
        SHOPIFY_APP_CLIENT_ID: "",
        SHOPIFY_APP_CLIENT_SECRET: "",
        SHOPIFY_APP_CALLBACK_URL: "http://localhost/shopify/auth/callback",
      }),
    });
    const cfg = loadApiConfig();
    expect(cfg.shopify.clientId).toBeNull();
    expect(cfg.shopify.clientSecret).toBeNull();
    // callbackUrl + apiVersion are deployment-level — still present.
    expect(cfg.shopify.callbackUrl).toBe(
      "http://localhost/shopify/auth/callback",
    );
    expect(cfg.shopifyConnectRequiresProvisioning).toBe(true);
  });

  it("REJECTS global Shopify creds in pilot mode (no hybrid)", () => {
    restore = setEnv({
      NODE_ENV: "test",
      ALLOW_HTTP_CALLBACK: "",
      SHOPIFY_CONNECT_REQUIRES_PROVISIONING: "true",
      ...baseEnv({
        // Global creds present + pilot mode → fail fast.
        SHOPIFY_APP_CLIENT_ID: "cid",
        SHOPIFY_APP_CLIENT_SECRET: "cs",
        SHOPIFY_APP_CALLBACK_URL: "http://localhost/shopify/auth/callback",
      }),
    });
    expect(() => loadApiConfig()).toThrow(/must NOT be set when/);
  });

  it("still requires global Shopify creds in SaaS mode", () => {
    restore = setEnv({
      NODE_ENV: "test",
      ALLOW_HTTP_CALLBACK: "",
      SHOPIFY_CONNECT_REQUIRES_PROVISIONING: "",
      ...baseEnv({
        SHOPIFY_APP_CLIENT_ID: "",
        SHOPIFY_APP_CLIENT_SECRET: "",
        SHOPIFY_APP_CALLBACK_URL: "http://localhost/shopify/auth/callback",
      }),
    });
    expect(() => loadApiConfig()).toThrow(/SHOPIFY_APP_CLIENT_ID is required/);
  });

  it("threads optional Gmail Pub/Sub env into Google config", () => {
    restore = setEnv({
      NODE_ENV: "production",
      ALLOW_HTTP_CALLBACK: "",
      ...baseEnv({
        GOOGLE_OAUTH_CLIENT_ID: "google-cid",
        GOOGLE_OAUTH_CLIENT_SECRET: "google-secret",
        GOOGLE_OAUTH_CALLBACK_URL:
          "https://support-agent-api.nacirianas.com/google/auth/callback",
        GMAIL_PUBSUB_TOPIC: "projects/p/topics/gmail-inbox",
        GMAIL_PUSH_TOKEN: "push-token",
      }),
    });
    const cfg = loadApiConfig();
    expect(cfg.google?.pubsubTopic).toBe("projects/p/topics/gmail-inbox");
    expect(cfg.google?.pushToken).toBe("push-token");
  });
});
