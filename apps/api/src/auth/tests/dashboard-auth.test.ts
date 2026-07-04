import { describe, expect, it } from "vitest";
import {
  authenticateDashboardToken,
  isWorkspaceIdShape,
} from "../dashboard-auth.js";
import {
  makeStaticDashboardTokenVerifier,
  type DashboardTokenVerifier,
} from "../dashboard-jwt.js";
import { dashboardUserDecisionUuid } from "../dashboard-user-id.js";

// S14: the dashboard forwards the merchant's WorkOS access token; the api
// VERIFIES it and reads org_id / sub from the verified claims. There is no
// shared service token and no trusted x-org-id / x-user-id any more —
// `authenticateDashboardToken` is the seam where a bearer JWT becomes a
// verified org + (hashed) user id.
describe("authenticateDashboardToken", () => {
  // A stand-in verifier: the single token "valid-jwt" resolves to this identity.
  const verifier: DashboardTokenVerifier = makeStaticDashboardTokenVerifier(
    (token) =>
      token === "valid-jwt"
        ? { organizationId: "org_123", workosUserId: "user_abc" }
        : null,
  );
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
  const expectedUserId = dashboardUserDecisionUuid("user_abc");

  it("accepts a verified token and returns org + the sub-derived user id", async () => {
    const r = await authenticateDashboardToken(bearer("valid-jwt"), verifier);
    expect(r).toEqual({
      ok: true,
      organizationId: "org_123",
      userId: expectedUserId,
      workosUserId: "user_abc",
      userEmail: undefined,
      workspaceId: undefined,
    });
  });

  it("derives the user id from the verified sub, IGNORING any x-user-id header", async () => {
    const r = await authenticateDashboardToken(
      { ...bearer("valid-jwt"), "x-user-id": "attacker-controlled" },
      verifier,
    );
    expect(r).toMatchObject({ ok: true, userId: expectedUserId });
    expect((r as { userId: string }).userId).not.toBe("attacker-controlled");
  });

  it("does NOT trust a self-asserted x-org-id — org comes only from the token", async () => {
    const r = await authenticateDashboardToken(
      { ...bearer("valid-jwt"), "x-org-id": "org_evil" },
      verifier,
    );
    expect(r).toMatchObject({ ok: true, organizationId: "org_123" });
  });

  it("rejects a missing Authorization header with 401", async () => {
    const r = await authenticateDashboardToken({ "x-org-id": "org_123" }, verifier);
    expect(r).toEqual({ ok: false, status: 401, message: expect.any(String) });
  });

  it("rejects an unverifiable token with 401", async () => {
    const r = await authenticateDashboardToken(bearer("forged"), verifier);
    expect(r.ok).toBe(false);
    expect((r as { status: number }).status).toBe(401);
  });

  it("rejects an expired token with 401", async () => {
    const expiredVerifier: DashboardTokenVerifier = {
      verify: async () => ({ ok: false, reason: "expired" }),
    };
    const r = await authenticateDashboardToken(bearer("whatever"), expiredVerifier);
    expect(r.ok).toBe(false);
    expect((r as { status: number }).status).toBe(401);
  });

  it("ignores a non-Bearer Authorization scheme", async () => {
    const r = await authenticateDashboardToken(
      { authorization: "Basic valid-jwt" },
      verifier,
    );
    expect(r.ok).toBe(false);
    expect((r as { status: number }).status).toBe(401);
  });

  it("carries x-user-email when present (low-trust display/reconcile only)", async () => {
    const r = await authenticateDashboardToken(
      { ...bearer("valid-jwt"), "x-user-email": "owner@example.com" },
      verifier,
    );
    expect(r).toMatchObject({ ok: true, userEmail: "owner@example.com" });
  });

  it("carries x-workspace-id when present, undefined otherwise; empty = absent", async () => {
    const wsId = "7b9f8e3a-1d2c-4e5f-9a6b-8c7d6e5f4a3b";
    const withWs = await authenticateDashboardToken(
      { ...bearer("valid-jwt"), "x-workspace-id": wsId },
      verifier,
    );
    expect(withWs).toMatchObject({ ok: true, workspaceId: wsId });

    const emptyWs = await authenticateDashboardToken(
      { ...bearer("valid-jwt"), "x-workspace-id": "" },
      verifier,
    );
    expect((emptyWs as { workspaceId?: string }).workspaceId).toBeUndefined();
  });
});

// tenants.id is a Postgres `uuid` — querying it with a non-UUID string throws
// a cast error (→ 500). The shape guard turns garbage into a clean 400 before
// any query runs.
describe("isWorkspaceIdShape", () => {
  it("accepts canonical UUIDs (any ticket)", () => {
    expect(isWorkspaceIdShape("7b9f8e3a-1d2c-4e5f-9a6b-8c7d6e5f4a3b")).toBe(true);
    expect(isWorkspaceIdShape("7B9F8E3A-1D2C-4E5F-9A6B-8C7D6E5F4A3B")).toBe(true);
  });

  it("rejects non-UUID strings", () => {
    expect(isWorkspaceIdShape("")).toBe(false);
    expect(isWorkspaceIdShape("not-a-uuid")).toBe(false);
    expect(isWorkspaceIdShape("7b9f8e3a1d2c4e5f9a6b8c7d6e5f4a3b")).toBe(false);
    expect(isWorkspaceIdShape("7b9f8e3a-1d2c-4e5f-9a6b-8c7d6e5f4a3")).toBe(false);
    expect(
      isWorkspaceIdShape("7b9f8e3a-1d2c-4e5f-9a6b-8c7d6e5f4a3b; DROP TABLE"),
    ).toBe(false);
  });
});
