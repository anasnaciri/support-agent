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

export const retryAction = async (formData: FormData): Promise<void> => {
  const caseId = caseIdOf(formData);
  const ctx = await getDashboardContext();

  const result = await api.retry(ctx, caseId);

  revalidatePath(`/cases/${caseId}`);
  revalidatePath("/cases");
  redirect(`/cases/${caseId}?retried=${result.kind}`);
};

// Send a human-drafted customer reply while driving a taken-over case. Goes
// out on the same email thread the agent uses; the case stays in human_takeover.
export const sendReplyAction = async (formData: FormData): Promise<void> => {
  const caseId = caseIdOf(formData);
  const bodyText = formData.get("bodyText");
  const ctx = await getDashboardContext();

  const result = await api.sendReply(
    ctx,
    caseId,
    typeof bodyText === "string" ? bodyText : "",
  );

  revalidatePath(`/cases/${caseId}`);
  revalidatePath("/cases");
  redirect(`/cases/${caseId}?replied=${result.kind}`);
};

// Re-send the SAME drafted reply whose delivery failed (distinct from the
// agent retry above): requeues the failed reply-delivery for the worker sweep.
export const retrySendAction = async (formData: FormData): Promise<void> => {
  const caseId = caseIdOf(formData);
  const ctx = await getDashboardContext();

  const result = await api.retrySend(ctx, caseId);

  revalidatePath(`/cases/${caseId}`);
  revalidatePath("/cases");
  redirect(`/cases/${caseId}?retrySend=${result.kind}`);
};
