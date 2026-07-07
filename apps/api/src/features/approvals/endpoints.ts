import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import {
  applyApprovalDecision,
  decisionToEvent,
  makeEnqueuedWorkflowEvent,
  verifyApprovalToken,
  type ApprovalDecisionResult,
  type VerifyApprovalTokenResult,
} from "@support-agent/services";
import {
  UserId,
  type Approval,
  type DomainEvent,
} from "@support-agent/agent-core";
import type { ApiLayer } from "../../bootstrap.js";

// ============================================================
// Token parsing
// ============================================================

/**
 * Pull `?token=` from the request URL. We deliberately use `URL` for
 * parse safety (handles odd inputs like `/approvals/x/approve?token`).
 * The `host` placeholder is a parse hack: WHATWG URL needs an origin,
 * but we only care about pathname + searchParams.
 */
export const extractToken = (rawUrl: string): string | null => {
  try {
    const u = new URL(rawUrl, "http://placeholder.invalid");
    return u.searchParams.get("token");
  } catch {
    return null;
  }
};

/**
 * Match `/approvals/<id>/(approve|reject)` and pull the id. Reject any
 * id that doesn't look like a UUID — keeps stray paths from triggering
 * DB lookups, and gives us a sharp 400 on garbage input.
 */
const UUID_RE = /^[0-9a-f-]{36}$/iu;

export const matchApprovalRoute = (
  pathname: string,
): { readonly approvalId: string; readonly action: "approve" | "reject" } | null => {
  const m = /^\/approvals\/([^/]+)\/(approve|reject)$/u.exec(pathname);
  if (!m) return null;
  const approvalId = m[1]!;
  if (!UUID_RE.test(approvalId)) return null;
  return { approvalId, action: m[2] as "approve" | "reject" };
};

// ============================================================
// Decision orchestration
// ============================================================

export type ApprovalEndpointOutcome =
  | { readonly kind: "decided"; readonly approval: Approval }
  | { readonly kind: "already_decided"; readonly approval: Approval }
  | { readonly kind: "approval_not_found" }
  | { readonly kind: "bad_token"; readonly reason: VerifyApprovalTokenResult & { readonly ok: false } }
  | { readonly kind: "token_mismatch"; readonly tokenApprovalId: string }
  /**
   * The token is valid but was signed for the OTHER action — e.g. a
   * reject link's token replayed against the approve path (audit S3).
   */
  | { readonly kind: "token_action_mismatch"; readonly tokenAction: string };

// ============================================================
// Link verification (no state change)
// ============================================================
//
// Shared by the GET confirm page and the POST decision: token signature,
// approval-id binding, and action binding. The GET calls ONLY this —
// email-security scanners (Outlook SafeLinks, Gmail prefetch) follow GET
// links, so the GET must never decide anything (audit S2).

export interface VerifyApprovalLinkInput {
  readonly approvalId: string;
  readonly action: "approve" | "reject";
  readonly token: string;
  readonly signingKey: string;
}

export type VerifyApprovalLinkResult =
  | { readonly kind: "ok" }
  | { readonly kind: "bad_token"; readonly reason: VerifyApprovalTokenResult & { readonly ok: false } }
  | { readonly kind: "token_mismatch"; readonly tokenApprovalId: string }
  | { readonly kind: "token_action_mismatch"; readonly tokenAction: string };

export const verifyApprovalLink = (
  input: VerifyApprovalLinkInput,
): VerifyApprovalLinkResult => {
  const verified = verifyApprovalToken({
    token: input.token,
    secret: input.signingKey,
  });
  if (!verified.ok) {
    return { kind: "bad_token", reason: verified };
  }
  if (verified.approvalId !== input.approvalId) {
    return { kind: "token_mismatch", tokenApprovalId: verified.approvalId };
  }
  if (verified.action !== input.action) {
    return { kind: "token_action_mismatch", tokenAction: verified.action };
  }
  return { kind: "ok" };
};

export interface DecideApprovalOptions {
  readonly approvalId: string;
  readonly action: "approve" | "reject";
  readonly token: string;
  readonly signingKey: string;
  readonly layer: ApiLayer;
  /**
   * Publishes the resulting `approval.approved` / `approval.rejected`
   * workflow event so the worker resumes the ticket. Injected as a hook
   * so tests can assert publish without standing up pg-boss.
   */
  readonly publish: (event: DomainEvent) => Promise<void>;
  /**
   * Override for the manager UserId surfaced in the resulting domain
   * event. Default is a synthetic system id — when the dashboard lands
   * with real auth, the route handler can pass the real manager id.
   */
  readonly managerId?: UserId;
}

export const SYSTEM_MANAGER_ID = UserId(
  "00000000-0000-0000-0000-000000000000",
);

export const decideApproval = async (
  opts: DecideApprovalOptions,
): Promise<ApprovalEndpointOutcome> => {
  // 1.–2. Verify the token: signature first (constant-time, expiry after
  //    so a probe can't distinguish "bad sig" from "expired"), then the
  //    approval-id binding, then the action binding (audit S3 — a reject
  //    link's token must not approve by editing the path).
  const linkCheck = verifyApprovalLink({
    approvalId: opts.approvalId,
    action: opts.action,
    token: opts.token,
    signingKey: opts.signingKey,
  });
  if (linkCheck.kind !== "ok") {
    return linkCheck;
  }

  const managerId = opts.managerId ?? SYSTEM_MANAGER_ID;

  // 3. Apply the decision. Shared with the dashboard's server action
  //    so the two surfaces can't drift on idempotency / state-conflict
  //    semantics. The api flow doesn't pass a `tenantId` scope —
  //    possession of a valid signed token IS the auth here (the
  //    operator received the link in an email addressed to their
  //    tenant; cross-tenant token reuse would be a separate concern).
  const inner: ApprovalDecisionResult = await Effect.runPromise(
    Effect.provide(
      applyApprovalDecision({
        approvalId: opts.approvalId,
        action: opts.action,
        managerId,
      }),
      opts.layer,
    ),
  );

  // 4. Publish the workflow event for `decided` outcomes only. Failure
  //    to publish MUST NOT leave the approval row half-decided —
  //    the row is already approved/rejected; the worker just won't
  //    pick it up. Log loudly so ops can replay.
  const event = decisionToEvent(inner, opts.action, managerId);
  if (event) {
    try {
      await opts.publish(event);
    } catch (cause) {
      // eslint-disable-next-line no-console
      console.error(
        "[approval-endpoint] publish failed; row decided without event",
        { approvalId: opts.approvalId, cause },
      );
    }
  }
  return inner as ApprovalEndpointOutcome;
};

// ============================================================
// HTML rendering
// ============================================================
//
// Plain inline HTML — no template engine, no asset pipeline. The pages
// are confirmation receipts opened from email clicks; the only
// requirement is "looks fine in any browser, in <2KB". When the
// dashboard lands, these become redirects to the dashboard ticket page.

const SHELL_HEAD = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Support Agent</title><style>
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#f6f6f6;color:#111;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
.card{background:#fff;border-radius:12px;padding:32px 40px;max-width:560px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.title{font-size:20px;font-weight:600;margin:0 0 12px}
.muted{color:#666;font-size:14px;margin:0}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600;letter-spacing:.02em;margin-bottom:12px}
.badge.ok{background:#d1fae5;color:#065f46}
.badge.bad{background:#fee2e2;color:#991b1b}
.badge.info{background:#dbeafe;color:#1e40af}
</style></head><body><div class="card">`;
export const SHELL_FOOT = `</div></body></html>`;

const BUTTON_CSS = `.btn{display:inline-block;border:0;border-radius:8px;padding:10px 20px;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit}
.btn.ok{background:#0057ff;color:#fff}
.btn.bad{background:#991b1b;color:#fff}
a.dash{display:inline-block;margin-top:16px;font-size:14px;color:#1e40af}`;

export const SHELL_HEAD_WITH_BUTTONS = SHELL_HEAD.replace(
  "</style>",
  `\n${BUTTON_CSS}</style>`,
);

/** Minimal HTML-entity escape for values interpolated into pages. */
export const escapeHtml = (s: string): string =>
  s
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");

export interface RenderApprovalPageOptions {
  /**
   * Dashboard origin for the "View in dashboard" link on receipt pages
   * (audit U12). Omitted → no link (single-binary pilot without a
   * dashboard deploy).
   */
  readonly dashboardBaseUrl?: string | null;
}

const dashboardLink = (
  approvalId: string,
  opts?: RenderApprovalPageOptions,
): string =>
  opts?.dashboardBaseUrl
    ? `<a class="dash" href="${escapeHtml(`${opts.dashboardBaseUrl}/approvals/${approvalId}`)}">View this approval in the dashboard →</a>`
    : "";

/**
 * GET confirm page (audit S2). Renders a form whose POST carries the
 * token in the body — the GET itself never mutates, so email-security
 * scanners that prefetch links can't decide approvals. The token was
 * already verified (signature + id + action) before this renders.
 */
export const renderApprovalConfirmPage = (input: {
  readonly approvalId: string;
  readonly action: "approve" | "reject";
  readonly token: string;
}): { readonly status: number; readonly body: string } => {
  const ok = input.action === "approve";
  return {
    status: 200,
    body: `${SHELL_HEAD_WITH_BUTTONS}<span class="badge ${ok ? "ok" : "bad"}">${ok ? "Approve" : "Reject"}</span><h1 class="title">Confirm: ${ok ? "approve this reply?" : "reject this reply?"}</h1><p class="muted">${ok ? "Your support agent will send the proposed reply to the customer." : "The ticket will be escalated to your team for human handling."}</p><form method="post" action="/approvals/${escapeHtml(input.approvalId)}/${input.action}"><input type="hidden" name="token" value="${escapeHtml(input.token)}"><button class="btn ${ok ? "ok" : "bad"}" type="submit">${ok ? "Approve and send" : "Reject"}</button></form>${SHELL_FOOT}`,
  };
};

export const renderApprovalPage = (
  outcome: ApprovalEndpointOutcome,
  action: "approve" | "reject",
  opts?: RenderApprovalPageOptions,
): { readonly status: number; readonly body: string } => {
  switch (outcome.kind) {
    case "decided": {
      const ok = action === "approve";
      return {
        status: 200,
        body: `${SHELL_HEAD_WITH_BUTTONS}<span class="badge ${ok ? "ok" : "bad"}">${ok ? "Approved" : "Rejected"}</span><h1 class="title">${ok ? "Reply approved" : "Reply rejected"}</h1><p class="muted">${ok ? "Your support agent will send the reply to the customer in a moment." : "The ticket has been escalated to human takeover."}</p>${dashboardLink(outcome.approval.id, opts)}${SHELL_FOOT}`,
      };
    }
    case "already_decided": {
      const ok = outcome.approval.status === "approved";
      return {
        status: 200,
        body: `${SHELL_HEAD_WITH_BUTTONS}<span class="badge info">Already decided</span><h1 class="title">This approval has already been ${ok ? "approved" : escapeHtml(outcome.approval.status)}</h1><p class="muted">No further action is needed. Decision recorded ${outcome.approval.decidedAt?.toISOString() ?? ""}.</p>${dashboardLink(outcome.approval.id, opts)}${SHELL_FOOT}`,
      };
    }
    case "approval_not_found":
      return {
        status: 404,
        body: `${SHELL_HEAD_WITH_BUTTONS}<span class="badge bad">Not found</span><h1 class="title">Approval not found</h1><p class="muted">This link doesn't match any approval. It may have been deleted, or the URL is malformed.</p>${SHELL_FOOT}`,
      };
    case "bad_token":
      return {
        status: 400,
        body: `${SHELL_HEAD_WITH_BUTTONS}<span class="badge bad">Invalid link</span><h1 class="title">This link can't be used</h1><p class="muted">Reason: ${escapeHtml(outcome.reason.reason)}. Approval links expire after 30 days for safety; decide from the dashboard if you still need to act.</p>${SHELL_FOOT}`,
      };
    case "token_mismatch":
      return {
        status: 400,
        body: `${SHELL_HEAD_WITH_BUTTONS}<span class="badge bad">Invalid link</span><h1 class="title">This link can't be used</h1><p class="muted">The token doesn't match this approval id.</p>${SHELL_FOOT}`,
      };
    case "token_action_mismatch":
      return {
        status: 400,
        body: `${SHELL_HEAD_WITH_BUTTONS}<span class="badge bad">Invalid link</span><h1 class="title">This link can't be used</h1><p class="muted">The token was issued for a different action. Use the original button link from the email.</p>${SHELL_FOOT}`,
      };
  }
};

// ============================================================
// pg-boss publisher (mirror of gmail-webhook's local helper)
// ============================================================

const WORKFLOW_QUEUE = "workflow.events";

/**
 * Minimal shape this module needs from a pg-boss instance. Wider than
 * the actual `PgBoss` type so the caller can pass in stubs without
 * dragging the whole pg-boss type surface.
 */
export interface BossLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly send: (name: string, data: any, options?: any) => Promise<unknown>;
}

export const makePgBossApprovalPublisher = (
  acquireBoss: () => Promise<BossLike>,
) => async (event: DomainEvent): Promise<void> => {
  const boss = await acquireBoss();
  const enqueued = makeEnqueuedWorkflowEvent(event, { eventId: randomUUID() });
  await boss.send(
    WORKFLOW_QUEUE,
    {
      eventId: enqueued.eventId,
      event: enqueued.event,
      key: enqueued.key,
      enqueuedAt: enqueued.enqueuedAt.toISOString(),
    },
    { singletonKey: enqueued.key },
  );
};
