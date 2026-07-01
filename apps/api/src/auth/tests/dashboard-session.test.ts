import { describe, expect, it } from "vitest";

import {
  SESSION_COOKIE_NAME,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  makeSessionCodec,
  parseCookieHeader,
  refreshAccessToken,
  sanitizeReturnPath,
  serializeSessionCookie,
  serializeSessionClearCookie,
  signOAuthState,
  verifyOAuthState,
  type SessionPayload,
} from "../dashboard-session.js";

const PASSWORD = "test-session-password-at-least-32-chars-long";

const payload = (over: Partial<SessionPayload> = {}): SessionPayload => ({
  accessToken: "dash|org_a|user_a",
  refreshToken: "refresh_a",
  user: { id: "user_a", email: "a@example.com", firstName: "Ada", lastName: "L" },
  ...over,
});

describe("makeSessionCodec (JWE seal/unseal)", () => {
  it("round-trips a sealed session", async () => {
    const codec = makeSessionCodec(PASSWORD);
    const sealed = await codec.seal(payload());
    expect(typeof sealed).toBe("string");
    expect(sealed).not.toContain("dash|org_a"); // encrypted, not plaintext
    const back = await codec.unseal(sealed);
    expect(back).toEqual(payload());
  });

  it("returns null for a cookie sealed under a different password (tamper/foreign)", async () => {
    const sealed = await makeSessionCodec(PASSWORD).seal(payload());
    const other = makeSessionCodec("another-totally-different-password-32chars");
    expect(await other.unseal(sealed)).toBeNull();
  });

  it("returns null for garbage / empty input", async () => {
    const codec = makeSessionCodec(PASSWORD);
    expect(await codec.unseal("")).toBeNull();
    expect(await codec.unseal("not-a-jwe")).toBeNull();
    expect(await codec.unseal("a.b.c.d.e")).toBeNull();
  });
});

describe("cookie helpers", () => {
  it("parses a cookie header into a name→value map", () => {
    const map = parseCookieHeader(
      `${SESSION_COOKIE_NAME}=abc123; other=zzz; spaced = trimmed `,
    );
    expect(map[SESSION_COOKIE_NAME]).toBe("abc123");
    expect(map["other"]).toBe("zzz");
    expect(map["spaced"]).toBe("trimmed");
  });

  it("tolerates an empty/undefined header", () => {
    expect(parseCookieHeader(undefined)).toEqual({});
    expect(parseCookieHeader("")).toEqual({});
  });

  it("serializes a Secure/None cookie for https and a Lax cookie for http", () => {
    const https = serializeSessionCookie("VALUE", { secure: true });
    expect(https).toContain(`${SESSION_COOKIE_NAME}=VALUE`);
    expect(https).toMatch(/HttpOnly/i);
    expect(https).toMatch(/Secure/i);
    expect(https).toMatch(/SameSite=None/i);
    expect(https).toMatch(/Path=\//i);

    const http = serializeSessionCookie("VALUE", { secure: false });
    expect(http).not.toMatch(/Secure/i);
    expect(http).toMatch(/SameSite=Lax/i);
  });

  it("clears the cookie with Max-Age=0", () => {
    const cleared = serializeSessionClearCookie({ secure: true });
    expect(cleared).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(cleared).toMatch(/Max-Age=0/i);
  });
});

describe("buildAuthorizeUrl", () => {
  it("builds a WorkOS AuthKit authorize URL with state", () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: "client_123",
        redirectUri: "https://api.example.com/dashboard/auth/callback",
        state: "st8",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://api.workos.com/user_management/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("client_123");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://api.example.com/dashboard/auth/callback",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("provider")).toBe("authkit");
    expect(url.searchParams.get("state")).toBe("st8");
    expect(url.searchParams.get("screen_hint")).toBeNull();
  });

  it("adds screen_hint=sign-up when requested", () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: "c",
        redirectUri: "https://x/cb",
        state: "s",
        screenHint: "sign-up",
      }),
    );
    expect(url.searchParams.get("screen_hint")).toBe("sign-up");
  });
});

describe("exchangeAuthorizationCode", () => {
  const okFetch = (captured: { body?: unknown; url?: string }) =>
    (async (url: string, init?: RequestInit) => {
      captured.url = url;
      captured.body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          access_token: "at_1",
          refresh_token: "rt_1",
          organization_id: "org_a",
          user: { id: "user_a", email: "a@example.com", first_name: "Ada" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

  it("posts an authorization_code grant and maps the response to a SessionPayload", async () => {
    const captured: { body?: unknown; url?: string } = {};
    const res = await exchangeAuthorizationCode({
      clientId: "client_123",
      apiKey: "sk_test",
      code: "code_abc",
      fetchImpl: okFetch(captured),
    });
    expect(captured.url).toContain("/user_management/authenticate");
    expect(captured.body).toMatchObject({
      client_id: "client_123",
      client_secret: "sk_test",
      grant_type: "authorization_code",
      code: "code_abc",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.session.accessToken).toBe("at_1");
      expect(res.session.refreshToken).toBe("rt_1");
      expect(res.session.user).toEqual({
        id: "user_a",
        email: "a@example.com",
        firstName: "Ada",
        lastName: null,
      });
      expect(res.organizationId).toBe("org_a");
    }
  });

  it("fails soft on a non-2xx WorkOS response", async () => {
    const badFetch = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
      })) as unknown as typeof fetch;
    const res = await exchangeAuthorizationCode({
      clientId: "c",
      apiKey: "k",
      code: "bad",
      fetchImpl: badFetch,
    });
    expect(res.ok).toBe(false);
  });
});

describe("OAuth state (login-CSRF binding + returnTo)", () => {
  const KEY = "state-signing-key";

  it("round-trips a signed state", () => {
    const token = signOAuthState(KEY, { nonce: "n1", returnTo: "/cases/42" });
    expect(verifyOAuthState(KEY, token)).toEqual({
      nonce: "n1",
      returnTo: "/cases/42",
    });
  });

  it("rejects a tampered body or wrong key", () => {
    const token = signOAuthState(KEY, { nonce: "n1", returnTo: "/" });
    expect(verifyOAuthState("other-key", token)).toBeNull();
    const [body, sig] = token.split(".");
    expect(verifyOAuthState(KEY, `${body}x.${sig}`)).toBeNull();
    expect(verifyOAuthState(KEY, "garbage")).toBeNull();
  });
});

describe("sanitizeReturnPath (open-redirect guard)", () => {
  it("keeps safe relative paths", () => {
    expect(sanitizeReturnPath("/cases/42?tab=thread")).toBe("/cases/42?tab=thread");
    expect(sanitizeReturnPath("/")).toBe("/");
  });

  it("rejects absolute/protocol-relative/backslash/blank", () => {
    expect(sanitizeReturnPath("//evil.com")).toBe("/");
    expect(sanitizeReturnPath("https://evil.com")).toBe("/");
    expect(sanitizeReturnPath("/\\evil.com")).toBe("/");
    expect(sanitizeReturnPath("")).toBe("/");
    expect(sanitizeReturnPath(null)).toBe("/");
    expect(sanitizeReturnPath("/a\tb")).toBe("/");
  });
});

describe("refreshAccessToken", () => {
  it("posts a refresh_token grant (with organization_id when given)", async () => {
    const captured: { body?: unknown } = {};
    const okFetch = (async (_url: string, init?: RequestInit) => {
      captured.body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          access_token: "at_2",
          refresh_token: "rt_2",
          organization_id: "org_a",
          user: { id: "user_a", email: "a@example.com" },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const res = await refreshAccessToken({
      clientId: "client_123",
      apiKey: "sk_test",
      refreshToken: "rt_1",
      organizationId: "org_a",
      fetchImpl: okFetch,
    });
    expect(captured.body).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "rt_1",
      organization_id: "org_a",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.session.accessToken).toBe("at_2");
  });
});
