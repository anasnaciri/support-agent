"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getWorkOS } from "@workos-inc/authkit-nextjs";
import { api } from "@/lib/api-client";
import { requirePermission } from "@/lib/require-permission";

const PATH = "/settings/suppliers";

const str = (formData: FormData, key: string): string => {
  const v = formData.get(key);
  return typeof v === "string" ? v.trim() : "";
};

const back = (query: string): never => redirect(`${PATH}?${query}`);

// Invite a supplier: send the WorkOS org invitation (email), then persist the
// supplier + a pending invitation bound to the auto-ensured Supplier role (the
// api reconciles it on the supplier's first load). Mirrors inviteMemberAction.
export const inviteSupplierAction = async (
  formData: FormData,
): Promise<void> => {
  const ctx = await requirePermission("members.manage");
  const email = str(formData, "email");
  const name = str(formData, "name");
  if (!email || !email.includes("@")) {
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
    // Already an org member / live invite — still record the supplier binding
    // so reconcile works on their first load.
  }
  const { status, body } = await api.inviteSupplier(ctx, {
    email,
    ...(name ? { name } : {}),
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
