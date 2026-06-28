"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { api, getDashboardContext } from "@/lib/api-client";

import { parseResolutionForm } from "./parse-resolution";

// Save the scenario cards. Immutable fields come from the stored policy (re-read
// here), so the form can only change which actions are enabled + their
// permission, the supplier mode, and the notes. The api re-sanitizes through
// the same decoder the runtime reads with.
export const saveResolutionPolicyAction = async (
  formData: FormData,
): Promise<void> => {
  const ctx = await getDashboardContext();
  const { scenarios: stored } = await api.resolutionPolicy(ctx);
  const get = (name: string): string | null => {
    const v = formData.get(name);
    return typeof v === "string" ? v : null;
  };
  const next = parseResolutionForm(get, stored);
  await api.setResolutionPolicy(ctx, next);
  revalidatePath("/settings/resolution-policy");
  redirect("/settings/resolution-policy?saved=1");
};

// Toggle whether triage routes new cases to the resolution agent. Submitted by
// the switch on change; no redirect — the page revalidates in place.
export const toggleResolutionAgentAction = async (
  formData: FormData,
): Promise<void> => {
  const ctx = await getDashboardContext();
  const enabled = formData.get("enabled") === "on";
  await api.setResolutionAgentEnabled(ctx, enabled);
  revalidatePath("/settings/resolution-policy");
};
