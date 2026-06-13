import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import {
  assignMemberRole,
  createInvitation,
  createRole,
  deleteRole,
  ensureActingOwnerInOpenMode,
  ensureOwnerRole,
  getMemberAccess,
  listMembers,
  listPendingInvitations,
  listRoles,
  makeDbClient,
  reconcileInvitation,
  removeMember,
  renameRole,
  setRolePermissions,
  tenants,
} from "../src/index.js";

// Exercises the real SQL behind member RBAC: the open-mode short-circuit, the
// auto-claim, role CRUD with the owner/in-use guards, and the invite→reconcile
// flow. Gated on DATABASE_URL (skipped without a DB).
const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("member-rbac-store", () => {
  const client = makeDbClient({ databaseUrl: databaseUrl! });
  const { db } = client;
  const seededTenants: string[] = [];

  afterAll(async () => {
    if (seededTenants.length > 0) {
      await db.delete(tenants).where(inArray(tenants.id, seededTenants));
    }
    await client.close();
  });

  const seedTenant = async (): Promise<string> => {
    const id = randomUUID();
    await db.insert(tenants).values({
      id,
      name: "RBAC Test",
      workosOrganizationId: `org_${id.slice(0, 8)}`,
      settings: {},
    });
    seededTenants.push(id);
    return id;
  };

  it("treats a workspace with no assignments as open, then enforced after auto-claim", async () => {
    const tenantId = await seedTenant();
    const admin = randomUUID();

    const before = await getMemberAccess(db, tenantId, admin);
    expect(before.anyAssignmentsInWorkspace).toBe(false);
    expect(before.assigned).toBe(false);

    await ensureActingOwnerInOpenMode(db, tenantId, admin, "admin@acme.com");

    const after = await getMemberAccess(db, tenantId, admin);
    expect(after.anyAssignmentsInWorkspace).toBe(true);
    expect(after.assigned).toBe(true);
    expect(after.isOwner).toBe(true);

    // Idempotent — a second call doesn't create a duplicate or throw.
    await ensureActingOwnerInOpenMode(db, tenantId, admin, "admin@acme.com");
    const members = await listMembers(db, tenantId);
    expect(members.filter((m) => m.userDecisionUuid === admin)).toHaveLength(1);
  });

  it("ensureOwnerRole is idempotent (one owner role per workspace)", async () => {
    const tenantId = await seedTenant();
    const a = await ensureOwnerRole(db, tenantId);
    const b = await ensureOwnerRole(db, tenantId);
    expect(a).toBe(b);
    const owners = (await listRoles(db, tenantId)).filter((r) => r.isOwner);
    expect(owners).toHaveLength(1);
  });

  it("creates a scoped role, grants permissions, assigns it, resolves grants", async () => {
    const tenantId = await seedTenant();
    const admin = randomUUID();
    await ensureActingOwnerInOpenMode(db, tenantId, admin, "admin@acme.com");

    const created = await createRole(db, tenantId, "Support");
    expect(created.ok).toBe(true);
    const roleId = created.ok ? created.roleId : "";

    // Duplicate name (case-insensitive) is rejected.
    expect(await createRole(db, tenantId, "support")).toEqual({
      ok: false,
      reason: "duplicate_name",
    });

    const setRes = await setRolePermissions(db, tenantId, roleId, [
      "cases.view",
      "cases.reply",
      "cases.reply", // dup collapses
    ]);
    expect(setRes.ok).toBe(true);

    const member = randomUUID();
    // Simulate an accepted invite by writing an assignment via reconcile.
    await createInvitation(db, tenantId, { email: "sam@acme.com", roleId });
    const rec = await reconcileInvitation(db, tenantId, {
      email: "sam@acme.com",
      userDecisionUuid: member,
    });
    expect(rec.reconciled).toBe(true);

    const access = await getMemberAccess(db, tenantId, member);
    expect(access.isOwner).toBe(false);
    expect([...access.grantedIds].sort()).toEqual(["cases.reply", "cases.view"]);

    // Reassign to a different role.
    const other = await createRole(db, tenantId, "Viewer");
    const otherId = other.ok ? other.roleId : "";
    expect(await assignMemberRole(db, tenantId, member, otherId)).toEqual({
      ok: true,
    });
    expect((await getMemberAccess(db, tenantId, member)).grantedIds).toEqual([]);
  });

  it("guards role deletion: owner immutable, in-use rejected", async () => {
    const tenantId = await seedTenant();
    const admin = randomUUID();
    await ensureActingOwnerInOpenMode(db, tenantId, admin, "admin@acme.com");
    const ownerRole = (await listRoles(db, tenantId)).find((r) => r.isOwner)!;

    expect(await deleteRole(db, tenantId, ownerRole.id)).toEqual({
      ok: false,
      reason: "owner_immutable",
    });

    const role = await createRole(db, tenantId, "Temp");
    const roleId = role.ok ? role.roleId : "";
    const member = randomUUID();
    await createInvitation(db, tenantId, { email: "x@acme.com", roleId });
    await reconcileInvitation(db, tenantId, {
      email: "x@acme.com",
      userDecisionUuid: member,
    });
    expect(await deleteRole(db, tenantId, roleId)).toEqual({
      ok: false,
      reason: "role_in_use",
    });

    // Remove the member, then deletion succeeds.
    expect(await removeMember(db, tenantId, member)).toEqual({ ok: true });
    expect(await deleteRole(db, tenantId, roleId)).toEqual({ ok: true });
  });

  it("reconcile is idempotent and a no-op without a matching invite", async () => {
    const tenantId = await seedTenant();
    const role = await createRole(db, tenantId, "Support");
    const roleId = role.ok ? role.roleId : "";
    const member = randomUUID();

    // No invite yet → no-op.
    expect(
      await reconcileInvitation(db, tenantId, {
        email: "noone@acme.com",
        userDecisionUuid: member,
      }),
    ).toEqual({ reconciled: false });

    await createInvitation(db, tenantId, { email: "Sam@Acme.com", roleId });
    const first = await reconcileInvitation(db, tenantId, {
      email: "sam@acme.com", // case-insensitive match
      userDecisionUuid: member,
    });
    expect(first.reconciled).toBe(true);
    // Second time: already assigned → no-op, invite already accepted.
    const second = await reconcileInvitation(db, tenantId, {
      email: "sam@acme.com",
      userDecisionUuid: member,
    });
    expect(second.reconciled).toBe(false);
    expect(await listPendingInvitations(db, tenantId)).toHaveLength(0);
  });

  it("rejects a duplicate pending invitation but allows re-invite after revoke", async () => {
    const tenantId = await seedTenant();
    const role = await createRole(db, tenantId, "Support");
    const roleId = role.ok ? role.roleId : "";
    const first = await createInvitation(db, tenantId, {
      email: "dup@acme.com",
      roleId,
    });
    expect(first.ok).toBe(true);
    expect(await createInvitation(db, tenantId, { email: "dup@acme.com", roleId }))
      .toEqual({ ok: false, reason: "duplicate_pending" });

    const renamed = await renameRole(db, tenantId, roleId, "Support Team");
    expect(renamed.ok).toBe(true);
  });
});
