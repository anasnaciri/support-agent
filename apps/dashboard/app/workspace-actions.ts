"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { surfaceHomeForKind } from "@support-agent/dashboard-contracts";
import { getDashboardContext } from "@/lib/api-client";
import { WORKSPACE_COOKIE, WORKSPACE_COOKIE_MAX_AGE } from "@/lib/workspace";

/**
 * Pin the session to a workspace (cookie) and reload from that workspace's
 * surface home — the merchant dashboard for a merchant workspace, the fulfillment partner
 * portal for a fulfillment partner one (unified switcher).
 */
export const switchWorkspaceAction = async (
  formData: FormData,
): Promise<void> => {
  const ctx = await getDashboardContext();
  const id = String(formData.get("workspaceId") ?? "");
  // Server-side ownership check — the rail's list could be stale (workspace
  // deleted in another tab) or the input tampered with. Unknown → no-op.
  const target = ctx.workspaces.find((w) => w.id === id);
  if (!target) {
    redirect("/");
  }
  const store = await cookies();
  store.set(WORKSPACE_COOKIE, id, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: WORKSPACE_COOKIE_MAX_AGE,
  });
  revalidatePath("/", "layout");
  redirect(surfaceHomeForKind(target.kind));
};
