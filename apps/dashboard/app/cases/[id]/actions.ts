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

// Full retry: rebind the case to triage so the agent re-classifies and
// re-routes from scratch (vs `retryAction`, which re-runs the bound
// specialist's last step). Use when the routing itself was wrong.
export const retryFromTriageAction = async (
  formData: FormData,
): Promise<void> => {
  const caseId = caseIdOf(formData);
  const ctx = await getDashboardContext();

  const result = await api.retry(ctx, caseId, { fromTriage: true });

  revalidatePath(`/cases/${caseId}`);
  revalidatePath("/cases");
  redirect(`/cases/${caseId}?retried=${result.kind}`);
};

// Manually set the case status from the case-page dropdown (mark resolved,
// reopen, park waiting on the customer …). The api re-validates the move
// against the case state machine; the redirect surfaces the outcome banner.
export const setStatusAction = async (formData: FormData): Promise<void> => {
  const caseId = caseIdOf(formData);
  const status = formData.get("status");
  const ctx = await getDashboardContext();

  const result = await api.setStatus(
    ctx,
    caseId,
    typeof status === "string" ? status : "",
  );

  revalidatePath(`/cases/${caseId}`);
  revalidatePath("/cases");
  redirect(`/cases/${caseId}?statusChanged=${result.kind}`);
};

// Issue an agent-recommended refund directly from the case page. The agent took
// PATH B (recommend + draft a reply) so there's no approval to approve — this
// runs the equivalent of refund.create under the operator's authority. The
// amount + currency are the recommended values carried on the form.
export const issueRefundAction = async (formData: FormData): Promise<void> => {
  const caseId = caseIdOf(formData);
  const amount = formData.get("amount");
  const currencyCode = formData.get("currencyCode");
  const ctx = await getDashboardContext();

  const result = await api.issueRefund(ctx, caseId, {
    amount: typeof amount === "string" ? amount : "",
    currencyCode: typeof currencyCode === "string" ? currencyCode : "",
  });

  revalidatePath(`/cases/${caseId}`);
  revalidatePath("/cases");
  redirect(`/cases/${caseId}?refundIssued=${result.kind}`);
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

// Persist the workspace "Rephrase with AI" model from the composer dropdown.
// Returns whether it stuck (the picker is gated on settings.agents, so a
// reply-only member's change is refused). No redirect — the composer keeps its
// place.
export const setRephraseModelAction = async (
  model: string,
): Promise<{ readonly ok: boolean }> => {
  const ctx = await getDashboardContext();
  return api.setRephraseModel(ctx, model);
};

// AI-polish the current reply draft. Unlike the other actions this RETURNS its
// result to the client composer (no redirect) so the textarea can be swapped in
// place. Spent against the tenant's own LLM credential.
export const rephraseAction = async (
  text: string,
): Promise<{ readonly kind: string; readonly text?: string }> => {
  const ctx = await getDashboardContext();
  return api.rephrase(ctx, text);
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
