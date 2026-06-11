"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { signOut } from "@workos-inc/authkit-nextjs";

import { api, getDashboardContext } from "@/lib/api-client";
import { WORKSPACE_COOKIE } from "@/lib/workspace";

/**
 * Irreversibly delete the signed-in manager's tenant account. The api wipes
 * every tenant row synchronously and hands the WorkOS-org delete + deletion
 * email to the worker. On success we sign the manager out (their session is
 * now orphaned — tenant + org are gone) and land them on the public
 * /goodbye page.
 *
 * Defense-in-depth: the form requires the user to type the exact tenant
 * name, and we re-check it here in case the page's button gate is bypassed.
 */
export const deleteAccountAction = async (
  formData: FormData,
): Promise<void> => {
  const ctx = await getDashboardContext();
  const confirm = String(formData.get("confirm") ?? "").trim();
  if (confirm !== ctx.tenantName) {
    redirect("/settings/account?error=name_mismatch");
  }

  const res = await api.deleteAccount(ctx);
  if (res.status !== 200) {
    redirect("/settings/account?error=delete_failed");
  }

  await signOut({ returnTo: "/goodbye" });
};

/**
 * Delete only the ACTIVE workspace. The org, the other workspaces, and the
 * manager's session all survive — afterwards the dashboard lands on the
 * default workspace. Same typed-name confirmation pattern as the account
 * delete; the api refuses the last workspace (account delete is that door).
 */
export const deleteWorkspaceAction = async (
  formData: FormData,
): Promise<void> => {
  const ctx = await getDashboardContext();
  const confirm = String(formData.get("confirm") ?? "").trim();
  if (confirm !== ctx.tenantName) {
    redirect("/settings/account?error=workspace_name_mismatch");
  }
  if (ctx.workspaces.length <= 1) {
    redirect("/settings/account?error=last_workspace");
  }

  const res = await api.deleteWorkspace(ctx, ctx.workspaceId);
  if (res.status === 409) {
    redirect("/settings/account?error=last_workspace");
  }
  if (res.status !== 200) {
    redirect("/settings/account?error=workspace_delete_failed");
  }

  // Back to the default workspace (stale cookie would self-heal anyway).
  const store = await cookies();
  store.delete(WORKSPACE_COOKIE);
  revalidatePath("/", "layout");
  redirect("/?workspace_deleted=1");
};
