import { Effect } from "effect";
import {
  ApprovalService,
  TicketRepository,
  decideApprovalBundle,
  summarizeApprovalAction,
  verifyBundleReviewToken,
} from "@support-agent/services";
import {
  TicketId,
  type Approval,
  type DomainEvent,
  type Ticket,
} from "@support-agent/agent-core";
import type { ApiLayer } from "../../bootstrap.js";
import {
  SHELL_FOOT,
  SHELL_HEAD_WITH_BUTTONS,
  SYSTEM_MANAGER_ID,
  escapeHtml,
} from "./endpoints.js";

// ============================================================
// Bundle review endpoints (queued-approvals magic link)
// ============================================================
//
// The autonomous loop queues SEVERAL gated actions on one ticket and parks
// once; the merchant's Telegram ping carries a single signed link here.
// Unlike the single-approval links there are no bare approve/reject URLs:
// a bundle must never be decidable sight-unseen, so the GET renders a
// review page listing every queued action, and only the page's confirm
// POST decides — the S2 scanner rule (email prefetchers, Telegram's link
// preview fetcher) applies to the review link exactly as to email links.
//
// Decisions reuse `decideApprovalBundle`, the same contract as the
// dashboard's bundle buttons: ALL pending rows are decided first, then ONE
// event publishes so the runtime resumes the whole bundle in order. Token
// possession IS the auth (the link was pushed to the tenant's connected
// merchant channel), matching the single-approval email links.

export type BundleReviewError =
  | {
      readonly kind: "bad_token";
      readonly reason: "malformed" | "invalid_signature" | "expired";
    }
  /** Valid signature, but the token was minted for another ticket. */
  | { readonly kind: "token_mismatch" }
  | { readonly kind: "ticket_not_found" };

export type BundleReviewOutcome =
  | {
      readonly kind: "ok";
      readonly ticket: Ticket;
      readonly pending: ReadonlyArray<Approval>;
    }
  | { readonly kind: "no_pending"; readonly ticket: Ticket }
  | BundleReviewError;

export interface LoadBundleReviewInput {
  readonly ticketId: string;
  readonly token: string;
  readonly signingKey: string;
  readonly layer: ApiLayer;
}

/**
 * Verify the link and load what the review page shows. Never mutates —
 * this is everything the GET is allowed to do (audit S2).
 */
export const loadBundleReview = async (
  input: LoadBundleReviewInput,
): Promise<BundleReviewOutcome> => {
  const verified = verifyBundleReviewToken({
    token: input.token,
    secret: input.signingKey,
  });
  if (!verified.ok) return { kind: "bad_token", reason: verified.reason };
  if (verified.ticketId !== input.ticketId) return { kind: "token_mismatch" };

  return Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const repo = yield* TicketRepository;
        const approvals = yield* ApprovalService;
        const ticket = yield* repo
          .getById(TicketId(input.ticketId))
          .pipe(Effect.catchAll(() => Effect.succeed(null)));
        if (!ticket) return { kind: "ticket_not_found" } as const;
        const all = yield* approvals.listForTicket(ticket.tenantId, ticket.id);
        const pending = all.filter((a) => a.status === "pending");
        return pending.length === 0
          ? ({ kind: "no_pending", ticket } as const)
          : ({ kind: "ok", ticket, pending } as const);
      }),
      input.layer,
    ),
  );
};

export type BundleDecisionOutcome =
  | {
      readonly kind: "decided";
      readonly action: "approve" | "reject";
      readonly decidedCount: number;
    }
  | { readonly kind: "no_pending" }
  | BundleReviewError;

export interface DecideBundleFromLinkInput {
  readonly ticketId: string;
  readonly action: "approve" | "reject";
  readonly token: string;
  readonly signingKey: string;
  readonly layer: ApiLayer;
  /** Publishes the single bundle event so the worker resumes the ticket. */
  readonly publish: (event: DomainEvent) => Promise<void>;
}

export const decideBundleFromLink = async (
  input: DecideBundleFromLinkInput,
): Promise<BundleDecisionOutcome> => {
  const verified = verifyBundleReviewToken({
    token: input.token,
    secret: input.signingKey,
  });
  if (!verified.ok) return { kind: "bad_token", reason: verified.reason };
  if (verified.ticketId !== input.ticketId) return { kind: "token_mismatch" };

  const decided = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const repo = yield* TicketRepository;
        const ticket = yield* repo
          .getById(TicketId(input.ticketId))
          .pipe(Effect.catchAll(() => Effect.succeed(null)));
        if (!ticket) return null;
        // Same contract as the dashboard bundle buttons: decide ALL pending
        // rows, then hand back the ONE event to publish (slice-4d resume).
        return yield* decideApprovalBundle({
          tenantId: ticket.tenantId,
          ticketId: ticket.id,
          action: input.action,
          managerId: SYSTEM_MANAGER_ID,
        });
      }),
      input.layer,
    ),
  );
  if (decided === null) return { kind: "ticket_not_found" };
  if (!decided.event) return { kind: "no_pending" };

  try {
    await input.publish(decided.event);
  } catch (cause) {
    // Rows are decided; the worker just won't pick them up until ops
    // replays. Same stance as the single-approval endpoint.
    // eslint-disable-next-line no-console
    console.error(
      "[bundle-endpoint] publish failed; rows decided without event",
      { ticketId: input.ticketId, cause },
    );
  }
  return {
    kind: "decided",
    action: input.action,
    decidedCount: decided.decidedCount,
  };
};

// ============================================================
// HTML rendering
// ============================================================

const BUNDLE_CSS = `.actions{padding-left:20px;margin:16px 0 0}
.actions li{margin:12px 0;font-size:15px}
.draft{margin:6px 0 0;padding:8px 12px;border-left:3px solid #ddd;color:#444;font-size:14px;white-space:pre-wrap}
.btnrow{display:flex;gap:12px;margin-top:24px}`;

const BUNDLE_SHELL_HEAD = SHELL_HEAD_WITH_BUTTONS.replace(
  "</style>",
  `\n${BUNDLE_CSS}</style>`,
);

const DRAFT_PREVIEW_MAX = 600;

/**
 * One list item per queued action: a code-derived summary line, plus the
 * verbatim draft body for reply-like inputs (shown as a block so the
 * summary line doesn't have to carry it).
 */
const actionListItem = (approval: Approval): string => {
  const input = (
    approval.proposedInput && typeof approval.proposedInput === "object"
      ? approval.proposedInput
      : {}
  ) as Record<string, unknown>;
  const bodyText =
    typeof input["bodyText"] === "string" ? (input["bodyText"] as string) : null;
  // With a draft block below, the heading drops the inline quote the
  // Telegram one-liner carries (bodyText stripped before summarizing).
  const heading = summarizeApprovalAction(
    approval.tool,
    bodyText ? { ...input, bodyText: undefined } : input,
  );
  const draft = bodyText
    ? `<blockquote class="draft">${escapeHtml(bodyText.slice(0, DRAFT_PREVIEW_MAX))}</blockquote>`
    : "";
  return `<li>${escapeHtml(heading)}${draft}</li>`;
};

export interface RenderBundleReviewPageInput {
  readonly ticket: Ticket;
  readonly pending: ReadonlyArray<Approval>;
  readonly token: string;
  /** Dashboard origin for the edit / per-action surface; null → no link. */
  readonly dashboardBaseUrl: string | null;
}

export const renderBundleReviewPage = (
  input: RenderBundleReviewPageInput,
): { readonly status: number; readonly body: string } => {
  const n = input.pending.length;
  const countLabel = `${n} action${n === 1 ? "" : "s"}`;
  const ctxEmail = input.ticket.context["customerEmail"];
  const customer =
    typeof ctxEmail === "string" && ctxEmail.length > 0
      ? `<p class="muted">Customer: ${escapeHtml(ctxEmail)}</p>`
      : "";
  const subject = input.ticket.subject
    ? `<p class="muted">Ticket: ${escapeHtml(input.ticket.subject)}</p>`
    : "";
  const items = input.pending.map(actionListItem).join("");
  const tokenField = `<input type="hidden" name="token" value="${escapeHtml(input.token)}">`;
  const forms = `<div class="btnrow"><form method="post" action="/approvals/bundle/${escapeHtml(input.ticket.id)}/approve">${tokenField}<button class="btn ok" type="submit">Approve all ${countLabel}</button></form><form method="post" action="/approvals/bundle/${escapeHtml(input.ticket.id)}/reject">${tokenField}<button class="btn bad" type="submit">Reject all</button></form></div>`;
  // Editing a draft or deciding actions one by one needs the dashboard —
  // this page is deliberately approve-all / reject-all only.
  const dashLink = input.dashboardBaseUrl
    ? `<a class="dash" href="${escapeHtml(`${input.dashboardBaseUrl.replace(/\/+$/u, "")}/tickets/${input.ticket.id}`)}">View on dashboard → (edit drafts or decide individually)</a>`
    : "";
  return {
    status: 200,
    body: `${BUNDLE_SHELL_HEAD}<span class="badge info">Approval needed</span><h1 class="title">Approve ${countLabel}?</h1>${subject}${customer}<p class="muted">Your support agent queued the following and is waiting for your decision. Approving runs them in order; rejecting hands the ticket to your team.</p><ol class="actions">${items}</ol>${forms}${dashLink}${SHELL_FOOT}`,
  };
};

export const renderBundleDecisionPage = (
  outcome: Exclude<BundleDecisionOutcome, BundleReviewError>,
): { readonly status: number; readonly body: string } => {
  if (outcome.kind === "no_pending") {
    return {
      status: 200,
      body: `${BUNDLE_SHELL_HEAD}<span class="badge info">Already decided</span><h1 class="title">Nothing left to decide</h1><p class="muted">These actions were already decided — from the dashboard or an earlier click. No further action is needed.</p>${SHELL_FOOT}`,
    };
  }
  const ok = outcome.action === "approve";
  const countLabel = `${outcome.decidedCount} action${outcome.decidedCount === 1 ? "" : "s"}`;
  return {
    status: 200,
    body: `${BUNDLE_SHELL_HEAD}<span class="badge ${ok ? "ok" : "bad"}">${ok ? "Approved" : "Rejected"}</span><h1 class="title">${countLabel} ${ok ? "approved" : "rejected"}</h1><p class="muted">${ok ? "Your support agent is executing them now, in order." : "Nothing was sent or refunded. The ticket has been escalated to your team."}</p>${SHELL_FOOT}`,
  };
};

export const renderBundleReviewErrorPage = (
  outcome: BundleReviewError | { readonly kind: "no_pending" },
): { readonly status: number; readonly body: string } => {
  switch (outcome.kind) {
    case "no_pending":
      return renderBundleDecisionPage({ kind: "no_pending" });
    case "ticket_not_found":
      return {
        status: 404,
        body: `${BUNDLE_SHELL_HEAD}<span class="badge bad">Not found</span><h1 class="title">Ticket not found</h1><p class="muted">This link doesn't match any ticket. It may have been deleted, or the URL is malformed.</p>${SHELL_FOOT}`,
      };
    case "token_mismatch":
      return {
        status: 400,
        body: `${BUNDLE_SHELL_HEAD}<span class="badge bad">Invalid link</span><h1 class="title">This link can't be used</h1><p class="muted">The token doesn't match this ticket.</p>${SHELL_FOOT}`,
      };
    case "bad_token":
      return {
        status: 400,
        body: `${BUNDLE_SHELL_HEAD}<span class="badge bad">Invalid link</span><h1 class="title">This link can't be used</h1><p class="muted">Reason: ${escapeHtml(outcome.reason)}. Review links expire after 30 days for safety; decide from the dashboard if you still need to act.</p>${SHELL_FOOT}`,
      };
  }
};
