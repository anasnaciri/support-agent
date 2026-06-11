import { describe, expect, it } from "vitest";
import type { AdminTenantSummary } from "@support-agent/dashboard-contracts";
import { groupTenantsByOrg } from "../lib/group-tenants";

const t = (
  id: string,
  org: string | null,
  createdAt: string,
): AdminTenantSummary => ({
  id,
  name: `T-${id}`,
  workosOrganizationId: org,
  createdAt,
  shopifyApp: { provisioned: false, status: null },
  connectionCount: 0,
});

// With workspaces, several tenant rows share one WorkOS org — the operator
// console groups them so "one customer" reads as one block, ordered the way
// the dashboard orders workspaces (oldest = default first).
describe("groupTenantsByOrg", () => {
  it("groups rows sharing an org, workspaces oldest-first inside the group", () => {
    const groups = groupTenantsByOrg([
      t("b", "org_1", "2026-02-01T00:00:00Z"),
      t("a", "org_1", "2026-01-01T00:00:00Z"),
      t("c", "org_2", "2026-03-01T00:00:00Z"),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ organizationId: "org_1" });
    expect(groups[0]!.tenants.map((x) => x.id)).toEqual(["a", "b"]);
    expect(groups[1]).toMatchObject({ organizationId: "org_2" });
  });

  it("orders groups by their earliest workspace's createdAt", () => {
    const groups = groupTenantsByOrg([
      t("late", "org_late", "2026-05-01T00:00:00Z"),
      t("early-2", "org_early", "2026-04-01T00:00:00Z"),
      t("early-1", "org_early", "2026-01-01T00:00:00Z"),
    ]);
    expect(groups.map((g) => g.organizationId)).toEqual([
      "org_early",
      "org_late",
    ]);
  });

  it("collects org-less tenants (headless/Shopify-only) into a trailing null group", () => {
    const groups = groupTenantsByOrg([
      t("x", null, "2026-01-01T00:00:00Z"),
      t("y", "org_1", "2026-02-01T00:00:00Z"),
      t("z", null, "2026-03-01T00:00:00Z"),
    ]);
    expect(groups.map((g) => g.organizationId)).toEqual(["org_1", null]);
    expect(groups[1]!.tenants.map((g) => g.id)).toEqual(["x", "z"]);
  });

  it("returns no groups for no tenants", () => {
    expect(groupTenantsByOrg([])).toEqual([]);
  });
});
