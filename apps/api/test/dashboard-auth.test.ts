import { describe, expect, it } from "vitest";
import { parseDashboardAuth } from "../src/dashboard-auth.js";

// The dashboard (Cloudflare Worker) authenticates the merchant via WorkOS,
// then calls the api with a shared service token + the asserted WorkOS
// organization id. `parseDashboardAuth` is the pure header check; tenant
// resolution (org -> tenant) happens after, against the DB.
describe("parseDashboardAuth", () => {
  const token = "s3cret-service-token";

  it("accepts a matching Bearer token + x-org-id", () => {
    const r = parseDashboardAuth(
      { authorization: `Bearer ${token}`, "x-org-id": "org_123" },
      token,
    );
    expect(r).toMatchObject({ ok: true, organizationId: "org_123" });
  });

  it("carries x-user-id (manager id) when present, undefined otherwise", () => {
    const withUser = parseDashboardAuth(
      {
        authorization: `Bearer ${token}`,
        "x-org-id": "org_123",
        "x-user-id": "manager-uuid",
      },
      token,
    );
    expect(withUser).toEqual({
      ok: true,
      organizationId: "org_123",
      userId: "manager-uuid",
    });
    const withoutUser = parseDashboardAuth(
      { authorization: `Bearer ${token}`, "x-org-id": "org_123" },
      token,
    );
    expect((withoutUser as { userId?: string }).userId).toBeUndefined();
  });

  it("rejects a missing Authorization header with 401", () => {
    const r = parseDashboardAuth({ "x-org-id": "org_123" }, token);
    expect(r).toEqual({ ok: false, status: 401, message: expect.any(String) });
  });

  it("rejects a wrong token with 401", () => {
    const r = parseDashboardAuth(
      { authorization: "Bearer nope", "x-org-id": "org_123" },
      token,
    );
    expect(r.ok).toBe(false);
    expect((r as { status: number }).status).toBe(401);
  });

  it("rejects a token of a different length with 401 (no timing-unsafe throw)", () => {
    const r = parseDashboardAuth(
      { authorization: "Bearer x", "x-org-id": "org_123" },
      token,
    );
    expect(r.ok).toBe(false);
    expect((r as { status: number }).status).toBe(401);
  });

  it("rejects a valid token but missing x-org-id with 400", () => {
    const r = parseDashboardAuth({ authorization: `Bearer ${token}` }, token);
    expect(r.ok).toBe(false);
    expect((r as { status: number }).status).toBe(400);
  });

  it("ignores a non-Bearer Authorization scheme", () => {
    const r = parseDashboardAuth(
      { authorization: `Basic ${token}`, "x-org-id": "org_123" },
      token,
    );
    expect(r.ok).toBe(false);
    expect((r as { status: number }).status).toBe(401);
  });
});
