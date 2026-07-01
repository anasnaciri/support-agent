"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  api,
  getDashboardContext,
  type RefundContextOutcome,
  type RefundLineItemPayload,
} from "@/lib/api-client";

// The refund modal serializes its restock selection + shipping into hidden form
// fields; parse them back defensively (the api re-validates too).
const parseLineItemsField = (
  raw: FormDataEntryValue | null,
): ReadonlyArray<RefundLineItemPayload> | undefined => {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? (parsed as ReadonlyArray<RefundLineItemPayload>)
      : undefined;
  } catch {
    return undefined;
  }
};

const parseShippingField = (
  raw: FormDataEntryValue | null,
): { readonly amount: string; readonly currencyCode: string } | null => {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    return typeof p?.["amount"] === "string" &&
      typeof p?.["currencyCode"] === "string"
      ? { amount: p["amount"], currencyCode: p["currencyCode"] }
      : null;
  } catch {
    return null;
  }
};

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

// Hand-correct the customer and/or order the agent couldn't extract, from the
// pencil edit on the Customer / Order cards. Sends only the fields the card
// submitted (empty inputs are treated as "no change"). The api validates the
// email, resolves the order ref to a real Shopify order, and stamps the case.
export const editCaseDetailsAction = async (
  formData: FormData,
): Promise<void> => {
  const caseId = caseIdOf(formData);
  const ctx = await getDashboardContext();

  const field = (name: string): string | undefined => {
    const raw = formData.get(name);
    if (typeof raw !== "string") return undefined;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };
  const customerEmail = field("customerEmail");
  const customerName = field("customerName");
  const orderRef = field("orderRef");

  const result = await api.editCaseDetails(ctx, caseId, {
    ...(customerEmail !== undefined ? { customerEmail } : {}),
    ...(customerName !== undefined ? { customerName } : {}),
    ...(orderRef !== undefined ? { orderRef } : {}),
  });

  revalidatePath(`/cases/${caseId}`);
  revalidatePath("/cases");
  const params = new URLSearchParams({ detailsEdited: result.kind });
  if (result.orderResolved !== undefined) {
    params.set("orderResolved", String(result.orderResolved));
  }
  redirect(`/cases/${caseId}?${params.toString()}`);
};

// Resolve a case by hand from the case page — works even while the manager has
// taken it over ("a case that's with me"). The api bridges the close legally
// (human_takeover → in_progress → resolved) for this human action; the runtime's
// takeover guard and the §10 matrix are untouched.
export const resolveAction = async (formData: FormData): Promise<void> => {
  const caseId = caseIdOf(formData);
  const ctx = await getDashboardContext();

  const result = await api.resolveCase(ctx, caseId);

  revalidatePath(`/cases/${caseId}`);
  revalidatePath("/cases");
  redirect(`/cases/${caseId}?caseResolved=${result.kind}`);
};

// Issue an agent-recommended refund directly from the case page. The agent took
// PATH B (recommend + draft a reply) so there's no approval to approve — this
// runs the equivalent of refund.create under the operator's authority. The
// amount + currency are the recommended values carried on the form.
export const issueRefundAction = async (formData: FormData): Promise<void> => {
  const caseId = caseIdOf(formData);
  const amount = formData.get("amount");
  const currencyCode = formData.get("currencyCode");
  const reasonRaw = formData.get("reason");
  const lineItems = parseLineItemsField(formData.get("lineItems"));
  const ctx = await getDashboardContext();

  const result = await api.issueRefund(
    ctx,
    caseId,
    {
      amount: typeof amount === "string" ? amount : "",
      currencyCode: typeof currencyCode === "string" ? currencyCode : "",
    },
    {
      reason:
        typeof reasonRaw === "string" && reasonRaw.trim()
          ? reasonRaw.trim()
          : null,
      ...(lineItems ? { lineItems } : {}),
      shipping: parseShippingField(formData.get("shipping")),
    },
  );

  revalidatePath(`/cases/${caseId}`);
  revalidatePath("/cases");
  redirect(`/cases/${caseId}?refundIssued=${result.kind}`);
};

// Lazily load the refund modal's context (refundable line items + Shopify
// pricing) when the operator opens it — keeps the heavy 3-call Shopify fetch off
// every case-page render. Returns the discriminated outcome to the client.
export const loadRefundContextAction = async (
  caseId: string,
): Promise<RefundContextOutcome> => {
  const ctx = await getDashboardContext();
  return api.refundContext(ctx, caseId);
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
