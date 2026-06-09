"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { api, getDashboardContext } from "@/lib/api-client";

const caseIdOf = (formData: FormData): string => {
  const id = formData.get("caseId");
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("caseId missing from form data");
  }
  return id;
};

export const takeOverAction = async (formData: FormData): Promise<void> => {
  const caseId = caseIdOf(formData);
  const ctx = await getDashboardContext();

  const result = await api.takeover(ctx, caseId);

  revalidatePath(`/cases/${caseId}`);
  revalidatePath("/cases");
  revalidatePath("/approvals");
  redirect(`/cases/${caseId}?takenOver=${result.kind}`);
};

export const resumeAction = async (formData: FormData): Promise<void> => {
  const caseId = caseIdOf(formData);
  const ctx = await getDashboardContext();

  const result = await api.resume(ctx, caseId);

  revalidatePath(`/cases/${caseId}`);
  revalidatePath("/cases");
  redirect(`/cases/${caseId}?resumed=${result.kind}`);
};
