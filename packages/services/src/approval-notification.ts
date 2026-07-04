import type { ApprovalId, TicketId, TenantId } from "@support-agent/agent-core";
import { signApprovalToken } from "./approval-tokens.js";
import { derivePreview, deriveSubject } from "./agent-runtime-helpers.js";
import {
  approvalRequestedNotification,
  type MerchantNotification,
} from "./merchant-notification.js";
import type { SendApprovalLinkInput } from "./platform-mail.js";

// ============================================================
// Approval notification builder
// ============================================================
//
// A single place that turns a parked approval + link config into the two
// notification payloads (approval email + merchant push) and the signed
// one-click URLs. Both the runtime's park-for-approval path (the FIRST
// notification, at creation) and the maintenance cron's reminder pass (a
// RE-notification, when the first was dropped) call this — so the link
// format, the token action binding, and the draft preview/subject can't
// drift between "sent once" and "sent again".

export interface ApprovalLinkParams {
  /** Public API origin, e.g. https://support-agent-api.example.com. */
  readonly baseUrl: string;
  /** HMAC secret shared with apps/api (verifies the same tokens). */
  readonly signingKey: string;
  /** Token TTL in ms (production: 30 days). */
  readonly ttlMs: number;
}

export interface BuildApprovalNotificationInput {
  readonly approvalId: ApprovalId;
  readonly tenantId: TenantId;
  readonly ticketId: TicketId;
  /** The gated tool being approved, surfaced in the email/ping copy. */
  readonly tool: string;
  /** The proposed tool input — its bodyText/subject drive the preview. */
  readonly proposedInput: unknown;
  readonly linkConfig: ApprovalLinkParams;
  /** Clock injection for deterministic token signing in tests. */
  readonly nowMs?: number;
}

export interface ApprovalNotification {
  readonly approveUrl: string;
  readonly rejectUrl: string;
  readonly draftSubject: string | null;
  readonly draftPreview: string;
  /** Ready to hand to `PlatformMailService.sendApprovalLink`. */
  readonly mail: SendApprovalLinkInput;
  /** Ready to hand to `MerchantNotificationService.notify`. */
  readonly merchant: MerchantNotification;
}

export const buildApprovalNotification = (
  input: BuildApprovalNotificationInput,
): ApprovalNotification => {
  const { approvalId, ticketId, tenantId, tool, linkConfig } = input;
  // Each URL carries its OWN signed token with the action bound into the
  // HMAC (audit S3) — holding a reject link must not allow approving by
  // editing the path.
  const nowOverride = input.nowMs !== undefined ? { nowMs: input.nowMs } : {};
  const approveToken = signApprovalToken({
    approvalId,
    action: "approve",
    secret: linkConfig.signingKey,
    ttlMs: linkConfig.ttlMs,
    ...nowOverride,
  });
  const rejectToken = signApprovalToken({
    approvalId,
    action: "reject",
    secret: linkConfig.signingKey,
    ttlMs: linkConfig.ttlMs,
    ...nowOverride,
  });
  const approveUrl = `${linkConfig.baseUrl}/approvals/${approvalId}/approve?token=${encodeURIComponent(approveToken)}`;
  const rejectUrl = `${linkConfig.baseUrl}/approvals/${approvalId}/reject?token=${encodeURIComponent(rejectToken)}`;
  const draftPreview = derivePreview(input.proposedInput);
  const draftSubject = deriveSubject(input.proposedInput);

  const mail: SendApprovalLinkInput = {
    tenantId,
    approvalId,
    draftSubject,
    draftPreview,
    toolName: tool,
    approveUrl,
    rejectUrl,
  };
  const merchant = approvalRequestedNotification({
    ticketId,
    toolName: tool,
    draftSubject,
    draftPreview,
    approveUrl,
    rejectUrl,
  });
  return { approveUrl, rejectUrl, draftSubject, draftPreview, mail, merchant };
};
