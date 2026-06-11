"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { api, getDashboardContext } from "@/lib/api-client";
import { WORKSPACE_COOKIE, WORKSPACE_COOKIE_MAX_AGE } from "@/lib/workspace";

export interface CreateWorkspaceFormState {
  readonly error?: string;
}

/**
 * Create an additional workspace and switch into it. The api copies the
 * org's current legal acceptance onto the new workspace; a stale acceptance
 * routes to the legal page instead of failing opaquely.
 */
export const createWorkspaceAction = async (
  _prev: CreateWorkspaceFormState | null,
  formData: FormData,
): Promise<CreateWorkspaceFormState | null> => {
  const ctx = await getDashboardContext();
  const name = String(formData.get("name") ?? "").trim();
  const notificationEmail = String(
    formData.get("notificationEmail") ?? "",
  ).trim();
  if (name.length < 2) return { error: "Please enter a workspace name." };
  if (!notificationEmail.includes("@")) {
    return { error: "Please enter a valid notification email." };
  }

  const res = await api.createWorkspace(ctx, { name, notificationEmail });
  if (res.error === "legal_acceptance_required") {
    redirect("/settings/legal");
  }
  if (!res.result) {
    return { error: "Could not create the workspace. Please try again." };
  }

  const store = await cookies();
  store.set(WORKSPACE_COOKIE, res.result.workspaceId, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: WORKSPACE_COOKIE_MAX_AGE,
  });
  revalidatePath("/", "layout");
  redirect("/?workspace_created=1");
};
