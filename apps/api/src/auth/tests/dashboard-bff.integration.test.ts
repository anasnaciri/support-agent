import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";

import { startServer, type ServerHandle } from "../../server.js";
import type { ApiConfig } from "../../bootstrap.js";
import {
  TEST_DASHBOARD_VERIFIER,
  dashboardAuthHeaders,
} from "../../tests/support/dashboard-auth.js";
import { makeSessionCodec } from "../dashboard-session.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

const SPA_ORIGIN = "http://localhost:3199";
const SESSION_PASSWORD = "integration-bff-session-password-32-plus-chars";
const ORG = "org_bff";

// Fake WorkOS user-management authenticate: returns a session whose access
// token the TEST verifier accepts (`dash|org|user`).
const workosFetch = (async (url: string | URL, init?: RequestInit) => {
  if (String(url).includes("/user_management/authenticate")) {
    const grant = JSON.parse(String(init?.body)) as { grant_type: string };
    return new Response(
      JSON.stringify({
        access_token: `dash|${ORG}|user_a`,
        refresh_token: grant.grant_type === "refresh_token" ? "rt_2" : "rt_1",
        organization_id: ORG,
        user: {
          id: "user_a",
          email: "a@example.com",
          first_name: "Ada",
          last_name: null,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return new Response("not found", { status: 404 });
}) as unknown as typeof fetch;

const setCookieValue = (
  headers: Headers,
  name: string,
): string | undefined => {
  for (const c of headers.getSetCookie()) {
    const m = new RegExp(`^${name}=([^;]*)`).exec(c);
    if (m) return m[1];
  }
  return undefined;
};

describeIfDb("apps/api — dashboard BFF (cookie session) integration", () => {
  const codec = makeSessionCodec(SESSION_PASSWORD);
  const cfg = {
    port: 0,
    databaseUrl: databaseUrl!,
    encryptionKey: randomBytes(32),
    stateSigningKey: "state-key",
    shopify: {
      clientId: "c",
      clientSecret: "s",
      callbackUrl: "http://localhost/shopify/auth/callback",
      apiVersion: "2025-01",
    },
    google: null,
    approvalSigningKey: "a",
    dashboardBaseUrl: null,
    workos: {
      clientId: "client_test",
      jwksUrl: "https://example/jwks",
      issuer: null,
      apiKey: "sk_test",
    },
    dashboardBff: {
      sessionPassword: SESSION_PASSWORD,
      redirectUri: "http://localhost/dashboard/auth/callback",
      spaOrigins: [SPA_ORIGIN],
    },
  } as ApiConfig;

  let handle: ServerHandle | null = null;
  let base = "";

  beforeAll(async () => {
    handle = await startServer(cfg, {
      dashboardTokenVerifier: TEST_DASHBOARD_VERIFIER,
      dashboardSessionCodec: codec,
      workosOAuthFetch: workosFetch,
    });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle?.close();
  });

  const sealedCookie = async (): Promise<string> =>
    `sa-dash-session=${await codec.seal({
      accessToken: `dash|${ORG}|user_a`,
      refreshToken: "rt_1",
      user: { id: "user_a", email: "a@example.com", firstName: "Ada", lastName: null },
    })}`;

  it("login → callback mints a session cookie; whoami returns the identity", async () => {
    // Login: 302 to WorkOS with a signed state + a state-nonce cookie.
    const login = await fetch(`${base}/dashboard/auth/login?returnTo=/cases/7`, {
      redirect: "manual",
    });
    expect(login.status).toBe(302);
    const authorizeUrl = new URL(login.headers.get("location")!);
    expect(authorizeUrl.pathname).toBe("/user_management/authorize");
    const state = authorizeUrl.searchParams.get("state")!;
    const nonce = setCookieValue(login.headers, "sa-oauth-state")!;
    expect(state).toBeTruthy();
    expect(nonce).toBeTruthy();

    // Callback: exchange the code (fake WorkOS) and mint the session cookie.
    const cb = await fetch(
      `${base}/dashboard/auth/callback?code=abc&state=${encodeURIComponent(state)}`,
      { redirect: "manual", headers: { cookie: `sa-oauth-state=${nonce}` } },
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe(`${SPA_ORIGIN}/cases/7`);
    const session = setCookieValue(cb.headers, "sa-dash-session")!;
    expect(session).toBeTruthy();

    // Whoami with the minted cookie.
    const who = await fetch(`${base}/dashboard/auth/session`, {
      headers: { cookie: `sa-dash-session=${session}` },
    });
    expect(who.status).toBe(200);
    const body = (await who.json()) as { organizationId: string };
    expect(body.organizationId).toBe(ORG);
  });

  it("rejects a callback whose state nonce does not match the cookie (login CSRF)", async () => {
    const login = await fetch(`${base}/dashboard/auth/login`, {
      redirect: "manual",
    });
    const state = new URL(login.headers.get("location")!).searchParams.get("state")!;
    const cb = await fetch(
      `${base}/dashboard/auth/callback?code=abc&state=${encodeURIComponent(state)}`,
      { redirect: "manual", headers: { cookie: `sa-oauth-state=WRONG` } },
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toContain("/sign-in?error=auth_failed");
  });

  it("authenticates a /dashboard read by cookie, equal to the bearer path", async () => {
    const viaCookie = await fetch(`${base}/dashboard/tenant`, {
      headers: { cookie: await sealedCookie() },
    });
    const viaBearer = await fetch(`${base}/dashboard/tenant`, {
      headers: dashboardAuthHeaders(ORG, {}, "user_a"),
    });
    expect(viaCookie.status).toBe(200);
    expect(viaBearer.status).toBe(200);
    expect(await viaCookie.json()).toEqual(await viaBearer.json());
  });

  it("401s a /dashboard read with no credential", async () => {
    const res = await fetch(`${base}/dashboard/tenant`);
    expect(res.status).toBe(401);
  });

  it("CSRF: a cookie-authed POST needs an allowed Origin", async () => {
    const cookie = await sealedCookie();
    const noOrigin = await fetch(`${base}/dashboard/auth/refresh`, {
      method: "POST",
      headers: { cookie },
    });
    expect(noOrigin.status).toBe(403);

    const badOrigin = await fetch(`${base}/dashboard/auth/refresh`, {
      method: "POST",
      headers: { cookie, origin: "https://evil.com" },
    });
    expect(badOrigin.status).toBe(403);

    const okOrigin = await fetch(`${base}/dashboard/auth/refresh`, {
      method: "POST",
      headers: { cookie, origin: SPA_ORIGIN },
    });
    expect(okOrigin.status).toBe(200);
    expect(setCookieValue(okOrigin.headers, "sa-dash-session")).toBeTruthy();
  });

  it("CORS: preflight from the SPA origin is allowed, others are not", async () => {
    const allowed = await fetch(`${base}/dashboard/tenant`, {
      method: "OPTIONS",
      headers: {
        origin: SPA_ORIGIN,
        "access-control-request-method": "GET",
      },
    });
    expect(allowed.headers.get("access-control-allow-origin")).toBe(SPA_ORIGIN);
    expect(allowed.headers.get("access-control-allow-credentials")).toBe("true");

    const denied = await fetch(`${base}/dashboard/tenant`, {
      method: "OPTIONS",
      headers: {
        origin: "https://evil.com",
        "access-control-request-method": "GET",
      },
    });
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("logout clears the session cookie (no sid in token → no WorkOS logout URL)", async () => {
    const res = await fetch(`${base}/dashboard/auth/logout`, {
      method: "POST",
      headers: { cookie: await sealedCookie(), origin: SPA_ORIGIN },
    });
    expect(res.status).toBe(200);
    const cleared = res.headers
      .getSetCookie()
      .find((c) => c.startsWith("sa-dash-session="));
    expect(cleared).toMatch(/Max-Age=0/i);
    const body = (await res.json()) as { logoutUrl?: string | null };
    expect(body.logoutUrl ?? null).toBeNull();
  });

  it("logout ends the WorkOS session: returns the end-session URL from the token's sid", async () => {
    // Access token shaped like a real WorkOS JWT (payload carries `sid`).
    const b64 = (v: unknown): string =>
      Buffer.from(JSON.stringify(v)).toString("base64url");
    const jwtWithSid = `${b64({ alg: "RS256" })}.${b64({
      sid: "session_01XYZ",
      org_id: ORG,
      sub: "user_a",
    })}.sig`;
    const cookie = `sa-dash-session=${await codec.seal({
      accessToken: jwtWithSid,
      refreshToken: "rt_1",
      user: { id: "user_a", email: "a@example.com", firstName: "Ada", lastName: null },
    })}`;

    const res = await fetch(`${base}/dashboard/auth/logout`, {
      method: "POST",
      headers: {
        cookie,
        origin: SPA_ORIGIN,
        "content-type": "application/json",
      },
      body: JSON.stringify({ returnTo: "/goodbye?deleted=1" }),
    });
    expect(res.status).toBe(200);
    const cleared = res.headers
      .getSetCookie()
      .find((c) => c.startsWith("sa-dash-session="));
    expect(cleared).toMatch(/Max-Age=0/i);

    const body = (await res.json()) as { logoutUrl: string };
    const url = new URL(body.logoutUrl);
    expect(url.pathname).toBe("/user_management/sessions/logout");
    expect(url.searchParams.get("session_id")).toBe("session_01XYZ");
    // returnTo is sanitized to a same-origin SPA path and made absolute.
    expect(url.searchParams.get("return_to")).toBe(
      `${SPA_ORIGIN}/goodbye?deleted=1`,
    );
  });

  it("logout ignores an unsafe returnTo (open-redirect guard on return_to)", async () => {
    const b64 = (v: unknown): string =>
      Buffer.from(JSON.stringify(v)).toString("base64url");
    const jwtWithSid = `${b64({ alg: "RS256" })}.${b64({ sid: "session_01XYZ" })}.sig`;
    const cookie = `sa-dash-session=${await codec.seal({
      accessToken: jwtWithSid,
      refreshToken: "rt_1",
      user: { id: "user_a", email: "a@example.com", firstName: "Ada", lastName: null },
    })}`;
    const res = await fetch(`${base}/dashboard/auth/logout`, {
      method: "POST",
      headers: { cookie, origin: SPA_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ returnTo: "https://evil.com/phish" }),
    });
    const body = (await res.json()) as { logoutUrl: string };
    expect(new URL(body.logoutUrl).searchParams.get("return_to")).toBe(
      `${SPA_ORIGIN}/`,
    );
  });
});
