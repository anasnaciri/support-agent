import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { loadApiConfig } from "../src/bootstrap.js";

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
    "https://api.support-agent.nacirianas.com/shopify/auth/callback",
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
      "https://api.support-agent.nacirianas.com/shopify/auth/callback",
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
});
