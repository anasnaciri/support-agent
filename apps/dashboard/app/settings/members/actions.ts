"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getWorkOS } from "@workos-inc/authkit-nextjs";
import { api } from "@/lib/api-client";
import { requirePermission } from "@/lib/require-permission";
import { isRbacPermissionId } from "@support-agent/dashboard-contracts";

const PATH = "/settings/members";

const str = (formData: FormData, key: string): string => {
  const v = formData.get(key);
  return typeof v === "string" ? v.trim() : "";
};

const back = (query: string): never => redirect(`${PATH}?${query}`);

// Invite a teammate: send the WorkOS organization invitation (email), then
// persist the pending invitation row (email + role) the api reconciles on the
// invitee's first load.
export const inviteMemberAction = async (formData: FormData): Promise<void> => {
  const ctx = await requirePermission("members.manage");
  const email = str(formData, "email");
  const roleId = str(formData, "roleId");
  if (!email || !email.includes("@") || !roleId) {
    back("error=invalid_invite");
  }
  let workosInvitationId: string | undefined;
  try {
    const invitation = await getWorkOS().userManagement.sendInvitation({
      email,
      organizationId: ctx.organizationId,
    });
    workosInvitationId = invitation.id;
  } catch {
    // The user may already be an org member or have a live WorkOS invite —
    // still record the local role binding so reconcile works on their load.
  }
  const { status, body } = await api.inviteMember(ctx, {
    email,
    roleId,
    ...(workosInvitationId ? { workosInvitationId } : {}),
  });
  if (status !== 200) {
    const reason =
      (body as { error?: string } | null)?.error ?? "invite_failed";
    back(`error=${encodeURIComponent(reason)}`);
  }
  revalidatePath(PATH);
  back("ok=invited");
};

export const revokeInvitationAction = async (
  formData: FormData,
): Promise<void> => {
  const ctx = await requirePermission("members.manage");
  const id = str(formData, "invitationId");
  if (id) await api.revokeInvitation(ctx, id);
  revalidatePath(PATH);
  back("ok=revoked");
};

export const changeRoleAction = async (formData: FormData): Promise<void> => {
  const ctx = await requirePermission("members.manage");
  const userDecisionUuid = str(formData, "userDecisionUuid");
  const roleId = str(formData, "roleId");
  if (userDecisionUuid && roleId) {
    await api.setMemberRole(ctx, userDecisionUuid, roleId);
  }
  revalidatePath(PATH);
  back("ok=role_changed");
};

export const removeMemberAction = async (formData: FormData): Promise<void> => {
  const ctx = await requirePermission("members.manage");
  const userDecisionUuid = str(formData, "userDecisionUuid");
  if (userDecisionUuid) await api.removeMember(ctx, userDecisionUuid);
  revalidatePath(PATH);
  back("ok=removed");
};

export const createRoleAction = async (formData: FormData): Promise<void> => {
  const ctx = await requirePermission("members.manage");
  const name = str(formData, "name");
  if (!name) back("error=invalid_role");
  const { status, body } = await api.createRole(ctx, name);
  if (status !== 200) {
    const reason = (body as { error?: string } | null)?.error ?? "role_failed";
    back(`error=${encodeURIComponent(reason)}`);
  }
  revalidatePath(PATH);
  const newId = (body as { roleId?: string } | null)?.roleId;
  back(`ok=role_created${newId ? `&role=${encodeURIComponent(newId)}` : ""}`);
};

export const renameRoleAction = async (formData: FormData): Promise<void> => {
  const ctx = await requirePermission("members.manage");
  const roleId = str(formData, "roleId");
  const name = str(formData, "name");
  if (roleId && name) await api.renameRole(ctx, roleId, name);
  revalidatePath(PATH);
  back(`ok=role_renamed&role=${encodeURIComponent(roleId)}`);
};

export const deleteRoleAction = async (formData: FormData): Promise<void> => {
  const ctx = await requirePermission("members.manage");
  const roleId = str(formData, "roleId");
  if (roleId) {
    const { status, body } = await api.deleteRole(ctx, roleId);
    if (status !== 200) {
      const reason =
        (body as { error?: string } | null)?.error ?? "delete_failed";
      back(`error=${encodeURIComponent(reason)}`);
    }
  }
  revalidatePath(PATH);
  back("ok=role_deleted");
};

// Replace a role's permission grants from the checkbox set.
export const saveRolePermissionsAction = async (
  formData: FormData,
): Promise<void> => {
  const ctx = await requirePermission("members.manage");
  const roleId = str(formData, "roleId");
  const permissionIds = formData
    .getAll("permissionIds")
    .filter((v): v is string => typeof v === "string")
    .filter(isRbacPermissionId);
  if (roleId) await api.setRolePermissions(ctx, roleId, permissionIds);
  revalidatePath(PATH);
  back(`ok=permissions_saved&role=${encodeURIComponent(roleId)}`);
};
