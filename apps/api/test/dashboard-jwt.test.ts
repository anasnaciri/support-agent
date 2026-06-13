import { beforeAll, describe, expect, it } from "vitest";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
} from "jose";

import {
  makeJwksVerifier,
  makeStaticDashboardTokenVerifier,
  workosJwksUrl,
  type DashboardTokenVerifier,
} from "../src/dashboard-jwt.js";

// jose v5 doesn't re-export its key type names; derive the private-key type
// from generateKeyPair so the test tracks jose without naming them.
type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

// S14: apps/api authenticates the dashboard by VERIFYING the forwarded WorkOS
// access-token JWT (RS256, against WorkOS's client-scoped JWKS) and reading
// org_id / sub from the verified claims — instead of trusting a shared service
// token + self-asserted x-org-id. These tests exercise the verifier against a
// locally-minted keypair + JWKS (no network), which mirrors createRemoteJWKSet.

const ISSUER = "https://api.workos.com/user_management/client_test";

describe("dashboard-jwt verifier", () => {
  let priv: PrivateKey;
  let wrongPriv: PrivateKey;
  let verifier: DashboardTokenVerifier;

  const nowSec = () => Math.floor(Date.now() / 1000);

  const sign = async (
    payload: Record<string, unknown>,
    opts: { key?: PrivateKey; expSec?: number; kid?: string } = {},
  ): Promise<string> =>
    new SignJWT(payload)
      .setProtectedHeader({ alg: "RS256", kid: opts.kid ?? "test-key" })
      .setIssuer(ISSUER)
      .setIssuedAt(nowSec())
      .setExpirationTime(opts.expSec ?? nowSec() + 3600)
      .sign(opts.key ?? priv);

  beforeAll(async () => {
    const kp = await generateKeyPair("RS256");
    priv = kp.privateKey;
    const wrong = await generateKeyPair("RS256");
    wrongPriv = wrong.privateKey;

    const pubJwk: JWK = { ...(await exportJWK(kp.publicKey)), kid: "test-key", alg: "RS256" };
    const jwks = createLocalJWKSet({ keys: [pubJwk] });
    verifier = makeJwksVerifier(jwks, { issuer: ISSUER });
  });

  it("accepts a valid WorkOS access token and returns org_id + sub", async () => {
    const token = await sign({ org_id: "org_123", sub: "user_abc" });
    const result = await verifier.verify(token);
    expect(result).toEqual({
      ok: true,
      claims: { organizationId: "org_123", workosUserId: "user_abc" },
    });
  });

  it("rejects an expired token", async () => {
    const token = await sign(
      { org_id: "org_123", sub: "user_abc" },
      { expSec: nowSec() - 60 },
    );
    const result = await verifier.verify(token);
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a token signed by a different key (bad signature)", async () => {
    const token = await sign({ org_id: "org_123", sub: "user_abc" }, { key: wrongPriv });
    const result = await verifier.verify(token);
    expect(result).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("rejects a token from a different issuer", async () => {
    const token = await new SignJWT({ org_id: "org_123", sub: "user_abc" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer("https://evil.example/iss")
      .setIssuedAt(nowSec())
      .setExpirationTime(nowSec() + 3600)
      .sign(priv);
    const result = await verifier.verify(token);
    expect(result).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("rejects a verified token missing org_id", async () => {
    const token = await sign({ sub: "user_abc" });
    const result = await verifier.verify(token);
    expect(result).toEqual({ ok: false, reason: "missing_claims" });
  });

  it("rejects a verified token missing sub", async () => {
    const token = await sign({ org_id: "org_123" });
    const result = await verifier.verify(token);
    expect(result).toEqual({ ok: false, reason: "missing_claims" });
  });

  it("rejects an empty / malformed token", async () => {
    expect(await verifier.verify("")).toEqual({ ok: false, reason: "missing_token" });
    expect(await verifier.verify("not-a-jwt")).toEqual({
      ok: false,
      reason: "invalid_token",
    });
  });
});

describe("makeStaticDashboardTokenVerifier (test/inject helper)", () => {
  it("maps a recognised token to claims and rejects the rest", async () => {
    const v = makeStaticDashboardTokenVerifier((token) =>
      token === "good"
        ? { organizationId: "org_x", workosUserId: "user_x" }
        : null,
    );
    expect(await v.verify("good")).toEqual({
      ok: true,
      claims: { organizationId: "org_x", workosUserId: "user_x" },
    });
    expect(await v.verify("bad")).toEqual({ ok: false, reason: "invalid_token" });
    expect(await v.verify("")).toEqual({ ok: false, reason: "missing_token" });
  });
});

describe("workosJwksUrl", () => {
  it("builds the WorkOS client-scoped JWKS URL", () => {
    expect(workosJwksUrl("client_01ABC")).toBe(
      "https://api.workos.com/sso/jwks/client_01ABC",
    );
  });
});
