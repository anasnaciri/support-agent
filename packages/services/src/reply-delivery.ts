import { Context, Data, Effect, Layer } from "effect";
import type { AgentId, CaseId, TenantId } from "@support-agent/agent-core";

// ============================================================
// ReplyDeliveryService — durable retry of a FAILED customer-reply send
// ============================================================
//
// When a `conversation.reply` / `conversation.ask_customer` send fails (in the
// agent loop OR on approval-resume), the runtime enqueues the verbatim draft
// here instead of losing it. A worker sweep then re-sends due rows with backoff,
// and the dashboard "Retry sending email" button requeues one immediately.
//
// Tag in `services`, Live in `db` (dependency rule: the runtime never imports
// db; the outer Layer provides the Live impl). The worker sweep reads/writes the
// outbox through the plain db store functions directly (like supplier-notify).

// ------------------------------------------------------------
// The risk flag the runtime stamps on the case + the dashboard renders.
// ------------------------------------------------------------

export const REPLY_DELIVERY_FAILED_FLAG = "reply_delivery_failed";

// ------------------------------------------------------------
// Retry schedule (pure) — exponential backoff off a 60s base, capped at 30m.
// `attempt` is 1-based (attempt 1 = the first retry after the initial failure).
// ------------------------------------------------------------

const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 30 * 60_000;

export const nextReplyDeliveryBackoffMs = (attempt: number): number => {
  const n = Math.max(1, Math.floor(attempt));
  const ms = BACKOFF_BASE_MS * 2 ** (n - 1);
  return Math.min(ms, BACKOFF_CAP_MS);
};

// ------------------------------------------------------------
// Send-failure detection (pure) — decide whether a failed tool call is a
// RETRIABLE customer-reply delivery failure (enqueue + flag the case) vs. a
// validation reject (recipient guard, unbound mailbox) that a retry can't fix.
// ------------------------------------------------------------

export const REPLY_SEND_TOOLS: ReadonlySet<string> = new Set([
  "conversation.reply",
  "conversation.ask_customer",
]);

// Deterministic recipient/mailbox validation rejects from the send tools' own
// guards (surfaced as ToolOutputInvalid issue keys). A retry can NEVER fix these
// — the draft itself is addressed wrong — so they are the ONLY conversation-send
// failures that are NOT treated as a retriable delivery failure.
const NON_RETRIABLE_REPLY_ISSUES: ReadonlySet<string> = new Set([
  "mailbox_not_bound",
  "recipient_not_in_thread",
  "recipient_is_connected_mailbox",
]);

/**
 * Decide whether a FAILED customer-send tool call is a retriable delivery
 * failure (→ enqueue the draft into the outbox + flag the case) vs. a
 * deterministic validation reject the agent/human must handle.
 *
 * Default-retry: for `conversation.reply` / `ask_customer`, ANY real error is a
 * delivery failure worth capturing — a transport tag, an auth error, a timeout,
 * a bare `Error` from the connector, an unknown shape. We must never silently
 * lose a drafted reply just because the failure didn't match a fixed tag list
 * (the original bug: a non-tagged send error fell through to a generic
 * `approved_tool_failed`, dropping the draft). The ONLY exception is a failure
 * whose issue keys are ALL recipient/mailbox validation rejects.
 */
export const isReplyDeliverySendFailure = (
  toolName: string,
  err: unknown,
): boolean => {
  if (!REPLY_SEND_TOOLS.has(toolName)) return false;
  // A degenerate non-error (null / primitive) carries nothing to retry.
  if (!err || typeof err !== "object") return false;
  const rawIssues = (err as { readonly issues?: unknown }).issues;
  const issueKeys = Array.isArray(rawIssues)
    ? rawIssues
        .filter((i): i is string => typeof i === "string")
        .map((i) => i.split(":")[0] ?? i)
    : [];
  if (
    issueKeys.length > 0 &&
    issueKeys.every((k) => NON_RETRIABLE_REPLY_ISSUES.has(k))
  ) {
    return false;
  }
  return true;
};

// ------------------------------------------------------------
// Errors + Tag
// ------------------------------------------------------------

/**
 * The outbox row couldn't be written (DB failure). Transient/retryable — the
 * runtime logs and continues (it has already escalated/flagged the case), and
 * the failed send simply isn't durably retriable until a later pass.
 */
export class ReplyDeliveryWriteFailed extends Data.TaggedError(
  "ReplyDeliveryWriteFailed",
)<{
  readonly cause: unknown;
}> {}

export type ReplyDeliveryError = ReplyDeliveryWriteFailed;

export interface EnqueueReplyDeliveryServiceInput {
  readonly tenantId: TenantId;
  readonly caseId: CaseId;
  readonly agentId: AgentId | string;
  /** `conversation.reply` | `conversation.ask_customer`. */
  readonly tool: string;
  readonly mailbox: string | null;
  readonly draftId: string;
  /** The verbatim tool input, replayed as-is on retry. */
  readonly draft: unknown;
  /** The send error (`_tag` / message), kept for visibility. */
  readonly error: string;
}

export class ReplyDeliveryService extends Context.Tag("ReplyDeliveryService")<
  ReplyDeliveryService,
  {
    /**
     * Persist a failed customer-reply send for durable retry. The Live impl
     * applies the first-retry backoff and upserts the per-draft pending row.
     */
    readonly enqueue: (
      input: EnqueueReplyDeliveryServiceInput,
    ) => Effect.Effect<{ readonly id: string }, ReplyDeliveryError>;
  }
>() {}

// ------------------------------------------------------------
// Test layer — in-memory, deterministic
// ------------------------------------------------------------

export interface ReplyDeliveryTestHandle {
  readonly enqueued: ReadonlyArray<EnqueueReplyDeliveryServiceInput>;
}

export interface ReplyDeliveryTestFixtures {
  /** Fail every enqueue with a transient write error. */
  readonly writeFailed?: boolean;
}

export const makeReplyDeliveryServiceTest = (
  fixtures: ReplyDeliveryTestFixtures = {},
): {
  readonly layer: Layer.Layer<ReplyDeliveryService>;
  readonly handle: ReplyDeliveryTestHandle;
} => {
  const enqueued: Array<EnqueueReplyDeliveryServiceInput> = [];
  let seq = 0;
  const layer = Layer.succeed(
    ReplyDeliveryService,
    ReplyDeliveryService.of({
      enqueue: (input) =>
        Effect.suspend(() => {
          if (fixtures.writeFailed) {
            return Effect.fail(
              new ReplyDeliveryWriteFailed({ cause: "fixture: writeFailed" }),
            );
          }
          enqueued.push(input);
          seq += 1;
          return Effect.succeed({ id: `reply-delivery-${seq}` });
        }),
    }),
  );
  return {
    layer,
    handle: {
      get enqueued() {
        return enqueued;
      },
    },
  };
};

/** Layer-only convenience when the test doesn't need to inspect enqueues. */
export const ReplyDeliveryServiceTest = (
  fixtures: ReplyDeliveryTestFixtures = {},
): Layer.Layer<ReplyDeliveryService> =>
  makeReplyDeliveryServiceTest(fixtures).layer;
