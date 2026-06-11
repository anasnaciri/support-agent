import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  createWorkspaceForOrg,
  findTenantIdByWorkosOrg,
  findWorkspaceForOrg,
  listWorkspacesByWorkosOrg,
  makeDbClient,
  renameWorkspaceForOrg,
  tenantByWorkosOrg,
  tenants,
} from "../src/index.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

// Workspaces = multiple tenant rows per WorkOS org. The org→tenant unique
// index is relaxed to a plain index; "default workspace" is the oldest row
// (created_at ASC, id ASC) so header-less dashboard requests stay stable.
describeIfDb("workspaces (integration)", () => {
  const client = makeDbClient({ databaseUrl: databaseUrl! });
  const { db } = client;

  afterAll(async () => {
    await client.close();
  });

  const legalAcceptance = {
    dataProcessingNoticeVersion: "2026-06-01",
    dpaVersion: "2026-06-01",
    acceptedAt: new Date().toISOString(),
    acceptedByUserId: randomUUID(),
  };

  it("allows two tenant rows to share a workos organization", async () => {
    const org = `org_${randomUUID()}`;
    const a = randomUUID();
    const b = randomUUID();
    try {
      await db.insert(tenants).values({
        id: a,
        name: "Store A",
        workosOrganizationId: org,
      });
      await db.insert(tenants).values({
        id: b,
        name: "Store B",
        workosOrganizationId: org,
      });
      const rows = await db
        .select({ id: tenants.id })
        .from(tenants)
        .where(sql`${tenants.workosOrganizationId} = ${org}`);
      expect(rows).toHaveLength(2);
    } finally {
      await db
        .delete(tenants)
        .where(sql`${tenants.workosOrganizationId} = ${org}`);
    }
  });

  it("resolves the DEFAULT workspace deterministically (oldest created_at, id ASC)", async () => {
    const org = `org_${randomUUID()}`;
    // Force a tiebreak too: same created_at, ordered by id.
    const older = new Date("2026-01-01T00:00:00Z");
    const newer = new Date("2026-02-01T00:00:00Z");
    // Insert NEWEST first so "first inserted wins" can't pass by accident.
    const newest = randomUUID();
    const tieHigh = "ffffffff-0000-4000-8000-000000000000";
    const tieLow = "00000000-0000-4000-8000-000000000000";
    try {
      await db.insert(tenants).values({
        id: newest,
        name: "Newest",
        workosOrganizationId: org,
        createdAt: newer,
      });
      await db.insert(tenants).values({
        id: tieHigh,
        name: "Tie High",
        workosOrganizationId: org,
        createdAt: older,
      });
      await db.insert(tenants).values({
        id: tieLow,
        name: "Tie Low",
        workosOrganizationId: org,
        createdAt: older,
      });

      expect(await findTenantIdByWorkosOrg(db, org)).toBe(tieLow);
      expect((await tenantByWorkosOrg(db, org))?.id).toBe(tieLow);

      const list = await listWorkspacesByWorkosOrg(db, org);
      expect(list.map((w) => w.id)).toEqual([tieLow, tieHigh, newest]);
      expect(list[0]).toMatchObject({ name: "Tie Low" });
      expect(list[0]?.createdAt).toBeInstanceOf(Date);
      expect(list[0]).toHaveProperty("shopifyDomain", null);
    } finally {
      await db
        .delete(tenants)
        .where(sql`${tenants.workosOrganizationId} = ${org}`);
    }
  });

  it("findWorkspaceForOrg returns the row only for the owning org", async () => {
    const org = `org_${randomUUID()}`;
    const otherOrg = `org_${randomUUID()}`;
    const id = randomUUID();
    try {
      await db.insert(tenants).values({
        id,
        name: "Mine",
        workosOrganizationId: org,
      });
      expect(await findWorkspaceForOrg(db, org, id)).toMatchObject({
        id,
        name: "Mine",
      });
      expect(await findWorkspaceForOrg(db, otherOrg, id)).toBeNull();
      expect(await findWorkspaceForOrg(db, org, randomUUID())).toBeNull();
    } finally {
      await db.delete(tenants).where(sql`${tenants.id} = ${id}`);
    }
  });

  it("createWorkspaceForOrg is NOT idempotent by org — each call mints a workspace", async () => {
    const org = `org_${randomUUID()}`;
    try {
      const first = await createWorkspaceForOrg(db, {
        organizationId: org,
        name: "First",
        notificationEmail: "ops@example.com",
        legalAcceptance,
      });
      const second = await createWorkspaceForOrg(db, {
        organizationId: org,
        name: "Second",
        notificationEmail: "ops@example.com",
        legalAcceptance,
      });
      expect(first.workspaceId).not.toBe(second.workspaceId);
      const list = await listWorkspacesByWorkosOrg(db, org);
      expect(list.map((w) => w.name)).toEqual(["First", "Second"]);
    } finally {
      await db
        .delete(tenants)
        .where(sql`${tenants.workosOrganizationId} = ${org}`);
    }
  });

  it("renameWorkspaceForOrg renames only when the org owns the workspace", async () => {
    const org = `org_${randomUUID()}`;
    const id = randomUUID();
    try {
      await db.insert(tenants).values({
        id,
        name: "Before",
        workosOrganizationId: org,
      });
      expect(
        await renameWorkspaceForOrg(db, {
          organizationId: `org_${randomUUID()}`,
          workspaceId: id,
          name: "Hijacked",
        }),
      ).toBe(false);
      expect(
        await renameWorkspaceForOrg(db, {
          organizationId: org,
          workspaceId: id,
          name: "After",
        }),
      ).toBe(true);
      const row = await findWorkspaceForOrg(db, org, id);
      expect(row?.name).toBe("After");
    } finally {
      await db.delete(tenants).where(sql`${tenants.id} = ${id}`);
    }
  });
});
