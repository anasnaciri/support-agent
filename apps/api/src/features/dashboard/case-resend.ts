// ============================================================
// Dashboard "Resend approved reply" — recover a skipped approval (H9)
// ============================================================
//
// When a manager approves a `conversation.reply` AFTER the case is taken over,
// the runtime skips the delivery (`approval.stale_delivery_skipped`) and retires
// the approval — the drafted reply never reaches the customer. The case page
// surfaces that as an "approved but not sent" card; this is the DI orchestration
// core behind its one-click resend.
//
// Guards (in order): load the case → it must be `human_takeover` → there must be
// a resurfaceable approved reply. Only then do we deliver (the SAME draft, via
// ConversationService — idempotent on (mailbox, draftId), so a retry can't
// double-send). Post-send bookkeeping (audit `case.approved_reply_resent` +
// outbound message-id index) is best-effort: once the email has left we never
// downgrade a real send to a failure.
//
// The case stays in `human_takeover` — a person took it over and is driving, so
// (like the manual "Reply to customer" flow) they decide when to resolve. The
// `case.approved_reply_resent` marker retires the "approved but not sent" card
// regardless.

export interface ResendSent {
  readonly id: string;
  /** ISO-8601 send timestamp. */
  readonly sentAt: string;
}

export type ResendApprovedReplyOutcome =
  | { readonly kind: "resent"; readonly messageId: string; readonly sentAt: string }
  | { readonly kind: "case_not_found" }
  | { readonly kind: "not_in_takeover"; readonly status: string }
  | { readonly kind: "nothing_to_resend" }
  | { readonly kind: "send_failed"; readonly error: string };

export interface ResendApprovedReplyOptions {
  /** Tenant-scoped case status; `null` = not found / another tenant. */
  readonly loadCaseStatus: () => Promise<string | null>;
  /** The approval id of the resurfaceable approved-but-not-sent reply, or null. */
  readonly findResurfaceableApprovalId: () => Promise<string | null>;
  /** Load the approval's drafted reply and deliver it. Throws/rejects on failure. */
  readonly deliver: (approvalId: string) => Promise<ResendSent>;
  /** Best-effort post-send bookkeeping (resent audit marker + message-id index). */
  readonly recordResent: (approvalId: string, sent: ResendSent) => Promise<void>;
}

export const resendApprovedReply = async (
  opts: ResendApprovedReplyOptions,
): Promise<ResendApprovedReplyOutcome> => {
  const status = await opts.loadCaseStatus();
  if (status === null) return { kind: "case_not_found" };
  if (status !== "human_takeover") return { kind: "not_in_takeover", status };

  const approvalId = await opts.findResurfaceableApprovalId();
  if (!approvalId) return { kind: "nothing_to_resend" };

  let sent: ResendSent;
  try {
    sent = await opts.deliver(approvalId);
  } catch (cause) {
    return {
      kind: "send_failed",
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }

  try {
    await opts.recordResent(approvalId, sent);
  } catch (cause) {
    // The email already left — bookkeeping is best-effort. A re-run is safe
    // because the connector dedups on (mailbox, draftId).
    // eslint-disable-next-line no-console
    console.error("[resend approved] post-send bookkeeping failed", {
      approvalId,
      messageId: sent.id,
      cause,
    });
  }

  return { kind: "resent", messageId: sent.id, sentAt: sent.sentAt };
};
