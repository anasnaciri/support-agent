import { describe, expect, it } from "vitest";
import {
  isWorkspaceIdShape,
  parseDashboardAuth,
} from "../src/dashboard-auth.js";

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

  // Workspaces: the dashboard pins a request to one of the org's workspaces
  // (tenant rows) via `x-workspace-id`. Parsing stays pure; ownership is
  // checked after, against the DB.
  it("carries x-workspace-id when present, undefined otherwise", () => {
    const wsId = "7b9f8e3a-1d2c-4e5f-9a6b-8c7d6e5f4a3b";
    const withWs = parseDashboardAuth(
      {
        authorization: `Bearer ${token}`,
        "x-org-id": "org_123",
        "x-workspace-id": wsId,
      },
      token,
    );
    expect(withWs).toMatchObject({ ok: true, workspaceId: wsId });
    const withoutWs = parseDashboardAuth(
      { authorization: `Bearer ${token}`, "x-org-id": "org_123" },
      token,
    );
    expect(withoutWs.ok).toBe(true);
    expect((withoutWs as { workspaceId?: string }).workspaceId).toBeUndefined();
  });

  it("treats an empty x-workspace-id as absent", () => {
    const r = parseDashboardAuth(
      {
        authorization: `Bearer ${token}`,
        "x-org-id": "org_123",
        "x-workspace-id": "",
      },
      token,
    );
    expect(r.ok).toBe(true);
    expect((r as { workspaceId?: string }).workspaceId).toBeUndefined();
  });
});

// tenants.id is a Postgres `uuid` — querying it with a non-UUID string throws
// a cast error (→ 500). The shape guard turns garbage into a clean 400 before
// any query runs.
describe("isWorkspaceIdShape", () => {
  it("accepts canonical UUIDs (any case)", () => {
    expect(isWorkspaceIdShape("7b9f8e3a-1d2c-4e5f-9a6b-8c7d6e5f4a3b")).toBe(
      true,
    );
    expect(isWorkspaceIdShape("7B9F8E3A-1D2C-4E5F-9A6B-8C7D6E5F4A3B")).toBe(
      true,
    );
  });

  it("rejects non-UUID strings", () => {
    expect(isWorkspaceIdShape("")).toBe(false);
    expect(isWorkspaceIdShape("not-a-uuid")).toBe(false);
    expect(isWorkspaceIdShape("7b9f8e3a1d2c4e5f9a6b8c7d6e5f4a3b")).toBe(false);
    expect(isWorkspaceIdShape("7b9f8e3a-1d2c-4e5f-9a6b-8c7d6e5f4a3")).toBe(
      false,
    );
    expect(
      isWorkspaceIdShape("7b9f8e3a-1d2c-4e5f-9a6b-8c7d6e5f4a3b; DROP TABLE"),
    ).toBe(false);
  });
});
