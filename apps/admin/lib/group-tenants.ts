import type { AdminTenantSummary } from "@support-agent/dashboard-contracts";

export interface TenantOrgGroup {
  /** null → tenants with no WorkOS org (headless / Shopify-only). */
  readonly organizationId: string | null;
  /** Oldest (the dashboard's default workspace) first. */
  readonly tenants: ReadonlyArray<AdminTenantSummary>;
}

/**
 * Group the flat tenant list by WorkOS org — with workspaces, several rows
 * are one customer. Groups order by their earliest row's createdAt; rows
 * inside a group order oldest-first (matching the dashboard's default-
 * workspace rule); org-less rows trail in a null group.
 */
export const groupTenantsByOrg = (
  rows: ReadonlyArray<AdminTenantSummary>,
): ReadonlyArray<TenantOrgGroup> => {
  const byOrg = new Map<string | null, AdminTenantSummary[]>();
  for (const row of rows) {
    const key = row.workosOrganizationId;
    const group = byOrg.get(key);
    if (group) group.push(row);
    else byOrg.set(key, [row]);
  }
  const groups = [...byOrg.entries()].map(([organizationId, tenants]) => ({
    organizationId,
    tenants: [...tenants].sort((a, b) =>
      a.createdAt === b.createdAt
        ? a.id.localeCompare(b.id)
        : a.createdAt < b.createdAt
          ? -1
          : 1,
    ),
  }));
  return groups.sort((a, b) => {
    if (a.organizationId === null) return b.organizationId === null ? 0 : 1;
    if (b.organizationId === null) return -1;
    const aFirst = a.tenants[0]!.createdAt;
    const bFirst = b.tenants[0]!.createdAt;
    return aFirst === bFirst ? 0 : aFirst < bFirst ? -1 : 1;
  });
};
