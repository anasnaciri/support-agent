import type { ApprovalDetail, AuditEntry } from "@support-agent/dashboard-contracts";

// H9 — resurface an "approved but not sent" reply.
//
// When a manager approves a `conversation.reply` AFTER the case has been taken
// over by a human, the runtime records `approval.stale_delivery_skipped` and
// retires the approval (H1) — the drafted reply never reaches the customer. The
// operator needs to see that and one-click resend it. A resend records
// `case.approved_reply_resent`, which retires the resurfacing.

const approvalIdFromDetails = (details: unknown): string | null => {
  if (details && typeof details === "object" && "approvalId" in details) {
    const v = (details as { readonly approvalId?: unknown }).approvalId;
    return typeof v === "string" ? v : null;
  }
  return null;
};

/**
 * The approved customer reply that was never sent and should be resurfaced on
 * the case page, or `null`. A reply qualifies when its approval is `approved`,
 * is a `conversation.reply`, was skipped (`approval.stale_delivery_skipped`),
 * and has not since been resent (`case.approved_reply_resent`). Returns the most
 * recently created qualifying approval.
 */
export const resurfaceableApprovedReply = (
  auditEntries: ReadonlyArray<AuditEntry>,
  approvals: ReadonlyArray<ApprovalDetail>,
): ApprovalDetail | null => {
  const skipped = new Set<string>();
  const resent = new Set<string>();
  for (const e of auditEntries) {
    const id = approvalIdFromDetails(e.details);
    if (!id) continue;
    if (e.action === "approval.stale_delivery_skipped") skipped.add(id);
    else if (e.action === "case.approved_reply_resent") resent.add(id);
  }
  const candidates = approvals.filter(
    (a) =>
      a.status === "approved" &&
      a.tool === "conversation.reply" &&
      skipped.has(a.id) &&
      !resent.has(a.id),
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((latest, a) =>
    a.createdAt.localeCompare(latest.createdAt) > 0 ? a : latest,
  );
};
