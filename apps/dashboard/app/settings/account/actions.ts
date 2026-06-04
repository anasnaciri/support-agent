"use server";

import { redirect } from "next/navigation";
import { signOut } from "@workos-inc/authkit-nextjs";

import { api, getDashboardContext } from "@/lib/api-client";

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
