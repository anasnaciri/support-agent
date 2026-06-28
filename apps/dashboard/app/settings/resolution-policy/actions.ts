"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { api, getDashboardContext } from "@/lib/api-client";

import { parseResolutionForm } from "./parse-resolution";

// Save the scenario cards (built-in edits + merchant-authored custom
// scenarios). The form is parsed into a faithful payload; the api is the
// authority — its decoder forces built-in immutable fields from the seeded
// defaults and assigns stable, namespaced keys to custom scenarios.
export const saveResolutionPolicyAction = async (
  formData: FormData,
): Promise<void> => {
  const ctx = await getDashboardContext();
  const get = (name: string): string | null => {
    const v = formData.get(name);
    return typeof v === "string" ? v : null;
  };
  const next = parseResolutionForm(get);
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
