import { and, asc, desc, eq, lte, ne, sql } from "drizzle-orm";
import type { DrizzleDb } from "./client.js";
import { replyDeliveries } from "./schema.js";

// Plain DrizzleDb access for the customer-reply DELIVERY outbox — the durable
// store behind "a drafted reply failed to send". Mirrors the supplier
// notification outbox (supplier-store.ts): the agent runtime enqueues on a send
// failure (Tag in services / Live in db), the worker sweep relays due rows, and
// the `/dashboard/*` HTTP path (manual "Retry sending email") reads/requeues
// through these functions.
//
// Lifecycle: `pending` (a send failed, awaiting retry) → `sent` (delivered, the
// case auto-resolves) | `abandoned` (attempt cap tripped, the case parks in
// human_takeover). `draft` holds the verbatim tool input so a retry re-sends the
// SAME email without re-running the LLM. At most one `pending` row per
// (case, draftId) — a re-run of the same failed send bumps the existing row.

const LAST_ERROR_MAX = 500;

export interface EnqueueReplyDeliveryInput {
  readonly tenantId: string;
  readonly caseId: string;
  readonly agentId: string;
  /** The send tool to replay: `conversation.reply` | `conversation.ask_customer`. */
  readonly tool: string;
  readonly mailbox: string | null;
  readonly draftId: string;
  /** The verbatim tool input, replayed as-is on retry. */
  readonly draft: unknown;
  /** The send error (`_tag` / message), kept for visibility. */
  readonly error: string;
  /** When the first retry becomes due (caller applies the backoff schedule). */
  readonly nextAttemptAt: Date;
  readonly maxAttempts?: number;
}

/** The shape the worker sweep replays. */
export interface DueReplyDelivery {
  readonly id: string;
  readonly tenantId: string;
  readonly caseId: string;
  readonly agentId: string;
  readonly tool: string;
  readonly mailbox: string | null;
  readonly draftId: string;
  readonly draft: unknown;
  readonly attempts: number;
  readonly maxAttempts: number;
}

/** The shape the dashboard reads for surfacing + the manual retry button. */
export interface ReplyDeliveryForCase extends DueReplyDelivery {
  readonly status: string;
  readonly lastError: string | null;
  readonly nextAttemptAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Record a failed customer-reply send. If a `pending` row already exists for the
 * same (case, draftId) — a re-run of the same failed draft — bump its attempt
 * counter and reschedule instead of inserting a duplicate. Returns the row id.
 */
export const enqueueReplyDelivery = async (
  db: DrizzleDb,
  input: EnqueueReplyDeliveryInput,
): Promise<{ readonly id: string }> => {
  const existing = await db
    .select({ id: replyDeliveries.id })
    .from(replyDeliveries)
    .where(
      and(
        eq(replyDeliveries.caseId, input.caseId),
        eq(replyDeliveries.draftId, input.draftId),
        eq(replyDeliveries.status, "pending"),
      ),
    )
    .limit(1);
  const prior = existing[0];
  if (prior) {
    await db
      .update(replyDeliveries)
      .set({
        attempts: sql`${replyDeliveries.attempts} + 1`,
        lastError: input.error.slice(0, LAST_ERROR_MAX),
        nextAttemptAt: input.nextAttemptAt,
        updatedAt: new Date(),
      })
      .where(eq(replyDeliveries.id, prior.id));
    return { id: prior.id };
  }
  const inserted = await db
    .insert(replyDeliveries)
    .values({
      tenantId: input.tenantId,
      caseId: input.caseId,
      agentId: input.agentId,
      tool: input.tool,
      mailbox: input.mailbox,
      draftId: input.draftId,
      draft: input.draft as never,
      status: "pending",
      attempts: 1,
      ...(input.maxAttempts !== undefined
        ? { maxAttempts: input.maxAttempts }
        : {}),
      lastError: input.error.slice(0, LAST_ERROR_MAX),
      nextAttemptAt: input.nextAttemptAt,
    })
    .returning({ id: replyDeliveries.id });
  return { id: inserted[0]!.id };
};

const toDue = (r: {
  id: string;
  tenantId: string;
  caseId: string;
  agentId: string;
  tool: string;
  mailbox: string | null;
  draftId: string;
  draft: unknown;
  attempts: number;
  maxAttempts: number;
}): DueReplyDelivery => ({
  id: r.id,
  tenantId: r.tenantId,
  caseId: r.caseId,
  agentId: r.agentId,
  tool: r.tool,
  mailbox: r.mailbox,
  draftId: r.draftId,
  draft: r.draft,
  attempts: r.attempts,
  maxAttempts: r.maxAttempts,
});

/** Pending deliveries whose retry is due (`next_attempt_at <= now`), oldest first. */
export const listDueReplyDeliveries = async (
  db: DrizzleDb,
  now: Date,
  limit: number,
): Promise<ReadonlyArray<DueReplyDelivery>> => {
  const rows = await db
    .select({
      id: replyDeliveries.id,
      tenantId: replyDeliveries.tenantId,
      caseId: replyDeliveries.caseId,
      agentId: replyDeliveries.agentId,
      tool: replyDeliveries.tool,
      mailbox: replyDeliveries.mailbox,
      draftId: replyDeliveries.draftId,
      draft: replyDeliveries.draft,
      attempts: replyDeliveries.attempts,
      maxAttempts: replyDeliveries.maxAttempts,
    })
    .from(replyDeliveries)
    .where(
      and(
        eq(replyDeliveries.status, "pending"),
        lte(replyDeliveries.nextAttemptAt, now),
      ),
    )
    .orderBy(asc(replyDeliveries.nextAttemptAt))
    .limit(limit);
  return rows.map(toDue);
};

/** Mark a delivery sent — the reply finally went out; drops it from the sweep. */
export const markReplyDeliverySent = async (
  db: DrizzleDb,
  id: string,
): Promise<void> => {
  await db
    .update(replyDeliveries)
    .set({ status: "sent", sentAt: new Date(), updatedAt: new Date() })
    .where(eq(replyDeliveries.id, id));
};

/**
 * Record a failed retry: bump attempts + keep the error + reschedule. `status`
 * stays `pending` so the next due sweep retries it (until the caller abandons).
 */
export const recordReplyDeliveryFailure = async (
  db: DrizzleDb,
  id: string,
  error: string,
  nextAttemptAt: Date,
): Promise<void> => {
  await db
    .update(replyDeliveries)
    .set({
      attempts: sql`${replyDeliveries.attempts} + 1`,
      lastError: error.slice(0, LAST_ERROR_MAX),
      nextAttemptAt,
      updatedAt: new Date(),
    })
    .where(eq(replyDeliveries.id, id));
};

/** Give up: park the row at the attempt cap (the case stays in human_takeover). */
export const abandonReplyDelivery = async (
  db: DrizzleDb,
  id: string,
  error: string,
): Promise<void> => {
  await db
    .update(replyDeliveries)
    .set({
      status: "abandoned",
      attempts: sql`${replyDeliveries.attempts} + 1`,
      lastError: error.slice(0, LAST_ERROR_MAX),
      updatedAt: new Date(),
    })
    .where(eq(replyDeliveries.id, id));
};

/**
 * The case's most recent UNSENT delivery (pending or abandoned) — what the
 * dashboard surfaces ("delivery failed" + last error) and the retry button acts
 * on. Returns null when the case has no failed delivery (or it already sent).
 */
export const getActiveReplyDeliveryForCase = async (
  db: DrizzleDb,
  caseId: string,
): Promise<ReplyDeliveryForCase | null> => {
  const rows = await db
    .select()
    .from(replyDeliveries)
    .where(
      and(
        eq(replyDeliveries.caseId, caseId),
        ne(replyDeliveries.status, "sent"),
      ),
    )
    .orderBy(desc(replyDeliveries.createdAt))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    ...toDue(r),
    status: r.status,
    lastError: r.lastError,
    nextAttemptAt: r.nextAttemptAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
};

/**
 * Manual "Retry sending email": revive the case's failed delivery — flip it back
 * to `pending`, due now, with a fresh attempt budget so the merchant's explicit
 * retry isn't immediately abandoned. Returns the row id, or null if the case has
 * no failed delivery to retry.
 */
export const requeueReplyDeliveryNow = async (
  db: DrizzleDb,
  caseId: string,
): Promise<{ readonly id: string } | null> => {
  const active = await getActiveReplyDeliveryForCase(db, caseId);
  if (!active) return null;
  await db
    .update(replyDeliveries)
    .set({
      status: "pending",
      attempts: 0,
      nextAttemptAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(replyDeliveries.id, active.id));
  return { id: active.id };
};
