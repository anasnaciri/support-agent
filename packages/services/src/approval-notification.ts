import {
  toolDisplayName,
  type ApprovalId,
  type TicketId,
  type TenantId,
} from "@support-agent/agent-core";
import {
  signApprovalToken,
  signBundleReviewToken,
} from "./approval-tokens.js";
import { derivePreview, deriveSubject } from "./agent-runtime-helpers.js";
import {
  approvalRequestedNotification,
  bundleApprovalRequestedNotification,
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
  /** Mark a maintenance re-notification distinctly from the first send. */
  readonly reminder?: boolean;
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
  const displayToolName = toolDisplayName(tool);

  const mail: SendApprovalLinkInput = {
    tenantId,
    approvalId,
    draftSubject,
    draftPreview,
    toolName: displayToolName,
    ...(input.reminder ? { reminder: true } : {}),
    approveUrl,
    rejectUrl,
  };
  const merchant = approvalRequestedNotification({
    ticketId,
    toolName: displayToolName,
    ...(input.reminder ? { reminder: true } : {}),
    draftSubject,
    draftPreview,
    approveUrl,
    rejectUrl,
  });
  return { approveUrl, rejectUrl, draftSubject, draftPreview, mail, merchant };
};

// ============================================================
// Bundle (queued-approvals) notification builder
// ============================================================

export interface BuildBundleApprovalNotificationInput {
  readonly tenantId: TenantId;
  readonly ticketId: TicketId;
  readonly ticketSubject: string | null;
  readonly customerEmail: string | null;
  /** The queued approval rows, in proposal order. */
  readonly actions: ReadonlyArray<{
    readonly tool: string;
    readonly proposedInput: unknown;
  }>;
  readonly linkConfig: ApprovalLinkParams;
  /** Clock injection for deterministic token signing in tests. */
  readonly nowMs?: number;
}

export interface BundleApprovalNotification {
  /** Signed, ticket-bound magic link to the api's bundle review page. */
  readonly reviewUrl: string;
  /** Ready to hand to `MerchantNotificationService.notify`. */
  readonly merchant: MerchantNotification;
}

/**
 * Bundle counterpart of `buildApprovalNotification`. One signed link to
 * the review page (GET renders, POST decides — the link itself never
 * mutates), one ping listing every queued action. Shared by the runtime's
 * bundle park and any future reminder pass, so link format and copy can't
 * drift.
 */
export const buildBundleApprovalNotification = (
  input: BuildBundleApprovalNotificationInput,
): BundleApprovalNotification => {
  const { ticketId, linkConfig } = input;
  const nowOverride = input.nowMs !== undefined ? { nowMs: input.nowMs } : {};
  const token = signBundleReviewToken({
    ticketId,
    secret: linkConfig.signingKey,
    ttlMs: linkConfig.ttlMs,
    ...nowOverride,
  });
  const reviewUrl = `${linkConfig.baseUrl}/approvals/bundle/${ticketId}?token=${encodeURIComponent(token)}`;
  const merchant = bundleApprovalRequestedNotification({
    ticketId: input.ticketId,
    ticketSubject: input.ticketSubject,
    customerEmail: input.customerEmail,
    actions: input.actions,
    reviewUrl,
  });
  return { reviewUrl, merchant };
};
