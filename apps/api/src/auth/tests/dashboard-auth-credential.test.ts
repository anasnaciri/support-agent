import { describe, expect, it } from "vitest";

import {
  authenticateDashboardCredential,
  authenticateDashboardToken,
} from "../dashboard-auth.js";
import { makeStaticDashboardTokenVerifier } from "../dashboard-jwt.js";
import { dashboardUserDecisionUuid } from "../dashboard-user-id.js";
import {
  SESSION_COOKIE_NAME,
  makeSessionCodec,
  type SessionPayload,
} from "../dashboard-session.js";

// Static verifier: a `dash|org|user` token resolves to those claims (same shape
// as the integration harness), everything else is invalid; an ACCESS token of
// `expired|...` maps to an explicit expired failure.
const verifier = makeStaticDashboardTokenVerifier((t) => {
  const m = /^dash\|([^|]+)\|([^|]*)$/u.exec(t);
  return m ? { organizationId: m[1]!, workosUserId: m[2]! || "user_x" } : null;
});

const codec = makeSessionCodec("credential-test-password-at-least-32-chars");

const sealedCookie = async (over: Partial<SessionPayload> = {}) => {
  const payload: SessionPayload = {
    accessToken: "dash|org_a|user_a",
    refreshToken: "rt",
    user: { id: "user_a", email: "sealed@example.com", firstName: null, lastName: null },
    ...over,
  };
  return `${SESSION_COOKIE_NAME}=${await codec.seal(payload)}`;
};

describe("authenticateDashboardCredential — Bearer path (unchanged, regression)", () => {
  it("delegates to authenticateDashboardToken byte-for-byte", async () => {
    const headers = {
      authorization: "Bearer dash|org_a|user_a",
      "x-user-email": "hdr@example.com",
      "x-workspace-id": "ws-1",
    };
    const viaCredential = await authenticateDashboardCredential(
      headers,
      verifier,
      codec,
    );
    const viaToken = await authenticateDashboardToken(headers, verifier);
    expect(viaCredential).toEqual(viaToken);
    expect(viaCredential).toEqual({
      ok: true,
      organizationId: "org_a",
      userId: dashboardUserDecisionUuid("user_a"),
      workosUserId: "user_a",
      userEmail: "hdr@example.com",
      workspaceId: "ws-1",
    });
  });

  it("prefers the bearer even when a cookie is also present", async () => {
    const headers = {
      authorization: "Bearer dash|org_bearer|user_bearer",
      cookie: await sealedCookie(),
    };
    const res = await authenticateDashboardCredential(headers, verifier, codec);
    expect(res.ok && res.organizationId).toBe("org_bearer");
  });
});

describe("authenticateDashboardCredential — cookie path (SPA)", () => {
  it("resolves the same identity a bearer would, with the VERIFIED sealed email", async () => {
    const headers = {
      cookie: await sealedCookie(),
      "x-user-email": "attacker@evil.com", // must be ignored on the cookie path
      "x-workspace-id": "ws-9",
    };
    const res = await authenticateDashboardCredential(headers, verifier, codec);
    expect(res).toEqual({
      ok: true,
      organizationId: "org_a",
      userId: dashboardUserDecisionUuid("user_a"),
      workosUserId: "user_a",
      userEmail: "sealed@example.com", // from the sealed session, NOT the header
      workspaceId: "ws-9",
    });
  });

  it("401s when the sealed access token no longer verifies", async () => {
    const headers = { cookie: await sealedCookie({ accessToken: "garbage-token" }) };
    const res = await authenticateDashboardCredential(headers, verifier, codec);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
  });

  it("401s on a tampered / foreign-sealed cookie", async () => {
    const foreign = makeSessionCodec("some-other-password-of-at-least-32-chars!!");
    const headers = {
      cookie: `${SESSION_COOKIE_NAME}=${await foreign.seal({
        accessToken: "dash|org_a|user_a",
        refreshToken: "rt",
        user: { id: "user_a", email: null, firstName: null, lastName: null },
      })}`,
    };
    const res = await authenticateDashboardCredential(headers, verifier, codec);
    expect(res.ok).toBe(false);
  });

  it("401s when no credential is present at all", async () => {
    const res = await authenticateDashboardCredential({}, verifier, codec);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
  });

  it("401s on a cookie when the BFF codec is not configured (null)", async () => {
    const headers = { cookie: await sealedCookie() };
    const res = await authenticateDashboardCredential(headers, verifier, null);
    expect(res.ok).toBe(false);
  });
});
