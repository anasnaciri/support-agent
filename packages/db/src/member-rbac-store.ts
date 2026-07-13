import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type {
  MemberInvitationView,
  MemberView,
  RbacPermissionId,
  RoleView,
} from "@support-agent/dashboard-contracts";
import type { DrizzleDb } from "./client.js";
import {
  memberInvitations,
  memberRoleAssignments,
  rolePermissions,
  roles,
} from "./schema.js";

// Plain DrizzleDb access for human-member RBAC — mirrors dashboard-reads.ts /
// dashboard-writes.ts (the `/dashboard/*` HTTP path uses plain db functions,
// NOT Effect service Tags). The agent runtime never touches these tables.
//
// The permission CATALOG is code (@support-agent/dashboard-contracts); these
// tables only store role↔permission GRANTS and member↔role ASSIGNMENTS.

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface MemberAccess {
  /** This user has an assignment row in this workspace. */
  readonly assigned: boolean;
  /** Assigned AND their role is the all-access owner role. */
  readonly isOwner: boolean;
  /** Raw granted permission ids from the user's role (empty for owner/none). */
  readonly grantedIds: ReadonlyArray<string>;
  /**
   * Whether ANY member has an assignment in this workspace. False → the
   * workspace is in "open" mode (pre-RBAC), and the api guard allows every
   * org member so the incumbent operator is never locked out.
   */
  readonly anyAssignmentsInWorkspace: boolean;
}

/**
 * The acting member's access facts for the api guard + the /me/session load.
 * `userDecisionUuid` is optional: a guarded READ may arrive without an actor id
 * (legacy/open-mode flows) — we still report `anyAssignmentsInWorkspace` so the
 * guard can allow it, but skip the per-user lookup (the column is uuid-typed,
 * so querying it with a non-uuid would throw).
 */
export const getMemberAccess = async (
  db: DrizzleDb,
  tenantId: string,
  userDecisionUuid: string | undefined,
): Promise<MemberAccess> => {
  const anyRows = await db
    .select({ one: sql<number>`1` })
    .from(memberRoleAssignments)
    .where(eq(memberRoleAssignments.tenantId, tenantId))
    .limit(1);
  const anyAssignmentsInWorkspace = anyRows.length > 0;

  if (!userDecisionUuid) {
    return {
      assigned: false,
      isOwner: false,
      grantedIds: [],
      anyAssignmentsInWorkspace,
    };
  }

  const assignmentRows = await db
    .select({ roleId: memberRoleAssignments.roleId, isOwner: roles.isOwner })
    .from(memberRoleAssignments)
    .innerJoin(roles, eq(roles.id, memberRoleAssignments.roleId))
    .where(
      and(
        eq(memberRoleAssignments.tenantId, tenantId),
        eq(memberRoleAssignments.userDecisionUuid, userDecisionUuid),
      ),
    )
    .limit(1);

  const assignment = assignmentRows[0];
  if (!assignment) {
    return {
      assigned: false,
      isOwner: false,
      grantedIds: [],
      anyAssignmentsInWorkspace,
    };
  }
  if (assignment.isOwner) {
    return {
      assigned: true,
      isOwner: true,
      grantedIds: [],
      anyAssignmentsInWorkspace,
    };
  }
  const grantRows = await db
    .select({ permissionId: rolePermissions.permissionId })
    .from(rolePermissions)
    .where(eq(rolePermissions.roleId, assignment.roleId));
  return {
    assigned: true,
    isOwner: false,
    grantedIds: grantRows.map((r) => r.permissionId),
    anyAssignmentsInWorkspace,
  };
};

/** Roles for the workspace, with their grants + how many members hold each. */
export const listRoles = async (
  db: DrizzleDb,
  tenantId: string,
): Promise<ReadonlyArray<RoleView>> => {
  const roleRows = await db
    .select({
      id: roles.id,
      name: roles.name,
      isOwner: roles.isOwner,
      createdAt: roles.createdAt,
    })
    .from(roles)
    .where(eq(roles.tenantId, tenantId))
    // Owner first, then by creation order.
    .orderBy(desc(roles.isOwner), asc(roles.createdAt));
  if (roleRows.length === 0) return [];

  const roleIds = roleRows.map((r) => r.id);
  const grantRows = await db
    .select({
      roleId: rolePermissions.roleId,
      permissionId: rolePermissions.permissionId,
    })
    .from(rolePermissions)
    .where(inArray(rolePermissions.roleId, roleIds));
  const assignmentRows = await db
    .select({ roleId: memberRoleAssignments.roleId })
    .from(memberRoleAssignments)
    .where(eq(memberRoleAssignments.tenantId, tenantId));

  const grantsByRole = new Map<string, RbacPermissionId[]>();
  for (const g of grantRows) {
    const list = grantsByRole.get(g.roleId) ?? [];
    list.push(g.permissionId as RbacPermissionId);
    grantsByRole.set(g.roleId, list);
  }
  const countByRole = new Map<string, number>();
  for (const a of assignmentRows) {
    countByRole.set(a.roleId, (countByRole.get(a.roleId) ?? 0) + 1);
  }
  return roleRows.map((r) => ({
    id: r.id,
    name: r.name,
    isOwner: r.isOwner,
    permissionIds: grantsByRole.get(r.id) ?? [],
    assignedMemberCount: countByRole.get(r.id) ?? 0,
  }));
};

/** Members (assignment rows) with their role name, newest first. */
export const listMembers = async (
  db: DrizzleDb,
  tenantId: string,
): Promise<ReadonlyArray<MemberView>> => {
  const rows = await db
    .select({
      userDecisionUuid: memberRoleAssignments.userDecisionUuid,
      email: memberRoleAssignments.email,
      roleId: memberRoleAssignments.roleId,
      roleName: roles.name,
      isOwner: roles.isOwner,
      createdAt: memberRoleAssignments.createdAt,
    })
    .from(memberRoleAssignments)
    .innerJoin(roles, eq(roles.id, memberRoleAssignments.roleId))
    .where(eq(memberRoleAssignments.tenantId, tenantId))
    .orderBy(asc(memberRoleAssignments.createdAt));
  return rows.map((r) => ({
    userDecisionUuid: r.userDecisionUuid,
    email: r.email,
    roleId: r.roleId,
    roleName: r.roleName,
    isOwner: r.isOwner,
    createdAt: r.createdAt.toISOString(),
  }));
};

/** Outstanding (pending) invitations for the workspace, newest first. */
export const listPendingInvitations = async (
  db: DrizzleDb,
  tenantId: string,
): Promise<ReadonlyArray<MemberInvitationView>> => {
  const rows = await db
    .select({
      id: memberInvitations.id,
      email: memberInvitations.email,
      roleId: memberInvitations.roleId,
      roleName: roles.name,
      status: memberInvitations.status,
      createdAt: memberInvitations.createdAt,
    })
    .from(memberInvitations)
    .innerJoin(roles, eq(roles.id, memberInvitations.roleId))
    .where(
      and(
        eq(memberInvitations.tenantId, tenantId),
        eq(memberInvitations.status, "pending"),
      ),
    )
    .orderBy(desc(memberInvitations.createdAt));
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    roleId: r.roleId,
    roleName: r.roleName,
    status: "pending",
    createdAt: r.createdAt.toISOString(),
  }));
};

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

const ownerRoleId = async (
  db: DrizzleDb,
  tenantId: string,
): Promise<string | null> => {
  const rows = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.tenantId, tenantId), eq(roles.isOwner, true)))
    .limit(1);
  return rows[0]?.id ?? null;
};

/**
 * Ensure the workspace has an Owner role (the all-access, undeletable role).
 * Idempotent — called from onboarding / workspace-create so every workspace,
 * not just migration-backfilled ones, has an Owner role to assign. Returns the
 * owner role id.
 */
export const ensureOwnerRole = async (
  db: DrizzleDb,
  tenantId: string,
): Promise<string> => {
  const existing = await ownerRoleId(db, tenantId);
  if (existing) return existing;
  const id = randomUUID();
  await db
    .insert(roles)
    .values({ id, tenantId, name: "Owner", isOwner: true })
    .onConflictDoNothing();
  return (await ownerRoleId(db, tenantId)) ?? id;
};

/**
 * Auto-claim: when a member performs a members.manage write while the
 * workspace is still in "open" mode (no assignments yet), make THAT acting
 * user the Owner first. This guarantees the admin keeps full access the moment
 * they start configuring roles — so a later-accepted invitee's assignment
 * (which flips the workspace to enforced) can't lock the admin out. Idempotent.
 */
export const ensureActingOwnerInOpenMode = async (
  db: DrizzleDb,
  tenantId: string,
  actingUuid: string,
  actingEmail: string,
  actingWorkosUserId?: string,
): Promise<void> => {
  const anyRows = await db
    .select({ one: sql<number>`1` })
    .from(memberRoleAssignments)
    .where(eq(memberRoleAssignments.tenantId, tenantId))
    .limit(1);
  if (anyRows.length > 0) return; // already enforced — nothing to claim
  const owner = await ensureOwnerRole(db, tenantId);
  await db
    .insert(memberRoleAssignments)
    .values({
      tenantId,
      userDecisionUuid: actingUuid,
      email: actingEmail,
      workosUserId: actingWorkosUserId ?? null,
      roleId: owner,
    })
    .onConflictDoNothing();
};

export type CreateRoleResult =
  | { readonly ok: true; readonly roleId: string }
  | { readonly ok: false; readonly reason: "duplicate_name" };

export const createRole = async (
  db: DrizzleDb,
  tenantId: string,
  name: string,
): Promise<CreateRoleResult> => {
  const dup = await db
    .select({ id: roles.id })
    .from(roles)
    .where(
      and(eq(roles.tenantId, tenantId), sql`lower(${roles.name}) = lower(${name})`),
    )
    .limit(1);
  if (dup[0]) return { ok: false, reason: "duplicate_name" };
  const id = randomUUID();
  await db.insert(roles).values({ id, tenantId, name });
  return { ok: true, roleId: id };
};

export type RoleMutationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        | "not_found"
        | "owner_immutable"
        | "role_in_use"
        | "duplicate_name";
    };

const roleInTenant = async (
  db: DrizzleDb,
  tenantId: string,
  roleId: string,
): Promise<{ readonly isOwner: boolean } | null> => {
  const rows = await db
    .select({ isOwner: roles.isOwner })
    .from(roles)
    .where(and(eq(roles.id, roleId), eq(roles.tenantId, tenantId)))
    .limit(1);
  return rows[0] ?? null;
};

export const renameRole = async (
  db: DrizzleDb,
  tenantId: string,
  roleId: string,
  name: string,
): Promise<RoleMutationResult> => {
  const role = await roleInTenant(db, tenantId, roleId);
  if (!role) return { ok: false, reason: "not_found" };
  if (role.isOwner) return { ok: false, reason: "owner_immutable" };
  const dup = await db
    .select({ id: roles.id })
    .from(roles)
    .where(
      and(
        eq(roles.tenantId, tenantId),
        sql`lower(${roles.name}) = lower(${name})`,
        sql`${roles.id} <> ${roleId}`,
      ),
    )
    .limit(1);
  if (dup[0]) return { ok: false, reason: "duplicate_name" };
  await db
    .update(roles)
    .set({ name, updatedAt: new Date() })
    .where(and(eq(roles.id, roleId), eq(roles.tenantId, tenantId)));
  return { ok: true };
};

export const deleteRole = async (
  db: DrizzleDb,
  tenantId: string,
  roleId: string,
): Promise<RoleMutationResult> => {
  const role = await roleInTenant(db, tenantId, roleId);
  if (!role) return { ok: false, reason: "not_found" };
  if (role.isOwner) return { ok: false, reason: "owner_immutable" };
  const assigned = await db
    .select({ one: sql<number>`1` })
    .from(memberRoleAssignments)
    .where(eq(memberRoleAssignments.roleId, roleId))
    .limit(1);
  if (assigned.length > 0) return { ok: false, reason: "role_in_use" };
  // role_permissions + any pending invitations cascade via FK.
  await db
    .delete(roles)
    .where(and(eq(roles.id, roleId), eq(roles.tenantId, tenantId)));
  return { ok: true };
};

/** Replace a role's permission grants atomically. Owner roles reject edits. */
export const setRolePermissions = async (
  db: DrizzleDb,
  tenantId: string,
  roleId: string,
  permissionIds: ReadonlyArray<string>,
): Promise<RoleMutationResult> => {
  const role = await roleInTenant(db, tenantId, roleId);
  if (!role) return { ok: false, reason: "not_found" };
  if (role.isOwner) return { ok: false, reason: "owner_immutable" };
  const unique = [...new Set(permissionIds)];
  await db.transaction(async (tx) => {
    await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
    if (unique.length > 0) {
      await tx
        .insert(rolePermissions)
        .values(unique.map((permissionId) => ({ roleId, permissionId })));
    }
    await tx
      .update(roles)
      .set({ updatedAt: new Date() })
      .where(eq(roles.id, roleId));
  });
  return { ok: true };
};

export type AssignResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "member_not_found" | "role_not_found" };

export const assignMemberRole = async (
  db: DrizzleDb,
  tenantId: string,
  userDecisionUuid: string,
  roleId: string,
): Promise<AssignResult> => {
  const role = await roleInTenant(db, tenantId, roleId);
  if (!role) return { ok: false, reason: "role_not_found" };
  const updated = await db
    .update(memberRoleAssignments)
    .set({ roleId, updatedAt: new Date() })
    .where(
      and(
        eq(memberRoleAssignments.tenantId, tenantId),
        eq(memberRoleAssignments.userDecisionUuid, userDecisionUuid),
      ),
    )
    .returning({ uuid: memberRoleAssignments.userDecisionUuid });
  if (updated.length === 0) return { ok: false, reason: "member_not_found" };
  return { ok: true };
};

export const removeMember = async (
  db: DrizzleDb,
  tenantId: string,
  userDecisionUuid: string,
): Promise<{ readonly ok: boolean }> => {
  const deleted = await db
    .delete(memberRoleAssignments)
    .where(
      and(
        eq(memberRoleAssignments.tenantId, tenantId),
        eq(memberRoleAssignments.userDecisionUuid, userDecisionUuid),
      ),
    )
    .returning({ uuid: memberRoleAssignments.userDecisionUuid });
  return { ok: deleted.length > 0 };
};

export type CreateInvitationResult =
  | { readonly ok: true; readonly invitationId: string }
  | {
      readonly ok: false;
      readonly reason: "role_not_found" | "duplicate_pending";
    };

export const createInvitation = async (
  db: DrizzleDb,
  tenantId: string,
  input: {
    readonly email: string;
    readonly roleId: string;
    readonly workosInvitationId?: string;
    readonly invitedByUuid?: string;
  },
): Promise<CreateInvitationResult> => {
  const role = await roleInTenant(db, tenantId, input.roleId);
  if (!role) return { ok: false, reason: "role_not_found" };
  const dup = await db
    .select({ id: memberInvitations.id })
    .from(memberInvitations)
    .where(
      and(
        eq(memberInvitations.tenantId, tenantId),
        sql`lower(${memberInvitations.email}) = lower(${input.email})`,
        eq(memberInvitations.status, "pending"),
      ),
    )
    .limit(1);
  if (dup[0]) return { ok: false, reason: "duplicate_pending" };
  const id = randomUUID();
  await db.insert(memberInvitations).values({
    id,
    tenantId,
    email: input.email,
    roleId: input.roleId,
    workosInvitationId: input.workosInvitationId ?? null,
    invitedByUuid: input.invitedByUuid ?? null,
  });
  return { ok: true, invitationId: id };
};

export const revokeInvitation = async (
  db: DrizzleDb,
  tenantId: string,
  invitationId: string,
): Promise<{ readonly ok: boolean }> => {
  const updated = await db
    .update(memberInvitations)
    .set({ status: "revoked" })
    .where(
      and(
        eq(memberInvitations.id, invitationId),
        eq(memberInvitations.tenantId, tenantId),
        eq(memberInvitations.status, "pending"),
      ),
    )
    .returning({ id: memberInvitations.id });
  return { ok: updated.length > 0 };
};

/**
 * Bind a signed-in user to any pending invitation matching their email: create
 * their assignment with the invited role and mark the invite accepted. Runs on
 * the invitee's first authenticated load. Idempotent — a no-op when the user
 * already has an assignment or there's no matching pending invite.
 */
export const reconcileInvitation = async (
  db: DrizzleDb,
  tenantId: string,
  input: {
    readonly email: string;
    readonly userDecisionUuid: string;
    readonly workosUserId?: string;
  },
): Promise<{ readonly reconciled: boolean; readonly roleId?: string }> => {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ uuid: memberRoleAssignments.userDecisionUuid })
      .from(memberRoleAssignments)
      .where(
        and(
          eq(memberRoleAssignments.tenantId, tenantId),
          eq(memberRoleAssignments.userDecisionUuid, input.userDecisionUuid),
        ),
      )
      .limit(1);
    if (existing[0]) return { reconciled: false };

    const invite = await tx
      .select({ id: memberInvitations.id, roleId: memberInvitations.roleId })
      .from(memberInvitations)
      .where(
        and(
          eq(memberInvitations.tenantId, tenantId),
          sql`lower(${memberInvitations.email}) = lower(${input.email})`,
          eq(memberInvitations.status, "pending"),
        ),
      )
      .limit(1);
    const pending = invite[0];
    if (!pending) return { reconciled: false };

    await tx.insert(memberRoleAssignments).values({
      tenantId,
      userDecisionUuid: input.userDecisionUuid,
      email: input.email,
      workosUserId: input.workosUserId ?? null,
      roleId: pending.roleId,
    });
    await tx
      .update(memberInvitations)
      .set({ status: "accepted", acceptedAt: new Date() })
      .where(eq(memberInvitations.id, pending.id));
    return { reconciled: true, roleId: pending.roleId };
  });
};
