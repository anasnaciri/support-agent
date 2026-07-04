import { Context, Effect, Layer, Option } from "effect";
import {
  isMerchantSettableStatus,
  isStatusTransitionAllowed,
  type AgentId,
  type Approval,
  type ApprovalId,
  type ApprovalRiskLevel,
  type Ticket,
  type TicketContext,
  type TicketId,
  type TicketStatus,
  type TenantId,
  type UserId,
} from "@support-agent/agent-core";
import {
  ApprovalService,
  type ApprovalServiceError,
} from "./approval-service.js";
import {
  type AuditLogError,
  AuditLogService,
  type AuditActor,
} from "./audit-log.js";
import {
  TicketRepository,
  type TicketRepositoryError,
} from "./ticket-repository.js";
import {
  REPLY_DELIVERY_FAILED_FLAG,
  ReplyDeliveryService,
  type ReplyDeliveryError,
} from "./reply-delivery.js";
import {
  ToolExecutionStore,
  type IdempotencyStoreDbError,
} from "./idempotency-store.js";
import { TransactionRunner } from "./transaction-runner.js";

type LifecycleDetails = Readonly<Record<string, unknown>>;

export interface EscalateToHumanInput {
  readonly ticketId: TicketId;
  readonly tenantId: TenantId;
  readonly actor: AuditActor;
  readonly reason: string;
  readonly details?: LifecycleDetails;
  readonly riskFlag?: string;
  readonly onlyFromStatus?: TicketStatus;
  readonly action?: string;
}

export interface ResolveTicketInput {
  readonly ticketId: TicketId;
  readonly tenantId: TenantId;
  readonly actor: AuditActor;
  readonly reason: string;
  readonly details?: LifecycleDetails;
  readonly clearRiskFlags?: ReadonlyArray<string>;
  readonly bridgeFromHumanTakeover?: boolean;
  readonly action?: string;
}

export interface ParkForApprovalInput {
  readonly ticketId: TicketId;
  readonly tenantId: TenantId;
  readonly agentId: AgentId;
  readonly tool: string;
  readonly proposedInput: unknown;
  readonly reasoning: string;
  readonly riskLevel: ApprovalRiskLevel;
  readonly expiresAt: Date;
  readonly turn: number;
}

export interface ParkForApprovalResult {
  readonly approval: Approval;
  readonly ticket_: Ticket;
}

/**
 * Queue a gated action WITHOUT parking the ticket (autonomous loop, slice 4b).
 * Same approval-row + audit write as {@link ParkForApprovalInput}, but it does
 * NOT transition the ticket status — the agent keeps looping. The ticket parks once,
 * at end-of-loop, via {@link ParkForApprovalBundleInput}.
 */
export interface QueueApprovalInput {
  readonly ticketId: TicketId;
  readonly tenantId: TenantId;
  readonly agentId: AgentId;
  readonly tool: string;
  readonly proposedInput: unknown;
  readonly reasoning: string;
  readonly riskLevel: ApprovalRiskLevel;
  readonly expiresAt: Date;
  readonly turn: number;
}

/**
 * Park a ticket for a bundle of already-queued approvals (autonomous loop end,
 * slice 4c). One `in_progress → waiting_for_approval` transition + one audit
 * row covering the whole bundle. The approval rows were created earlier by
 * {@link QueueApprovalInput}; this just flips the ticket so the merchant reviews
 * them together.
 */
export interface ParkForApprovalBundleInput {
  readonly ticketId: TicketId;
  readonly tenantId: TenantId;
  readonly agentId: AgentId;
  readonly approvalIds: ReadonlyArray<ApprovalId>;
  readonly turn: number;
}

export interface ParkForWaitInput {
  readonly ticketId: TicketId;
  readonly tenantId: TenantId;
  readonly agentId: AgentId;
  readonly tool: string;
  readonly callId: string;
}

export type ParkForSupplierManualOutcome =
  | { readonly kind: "parked"; readonly toStatus: TicketStatus }
  | {
      readonly kind: "transition_not_allowed";
      readonly fromStatus: TicketStatus;
    };

/**
 * A manager escalating a ticket to the supplier BY HAND from the ticket page. The
 * caller (db layer) writes the `ticket_supplier_escalations` row first; this
 * parks the ticket and records the audit row. Bridges `human_takeover →
 * in_progress → waiting_for_supplier` (like resolve's bridge) so §10 is never
 * bypassed, and leaves a `waiting_for_approval` ticket where it is — approval
 * wins the single primary status under concurrent waits; the open escalation
 * row carries the supplier wait on its own.
 */
export interface ParkForSupplierManualInput {
  readonly ticketId: TicketId;
  readonly tenantId: TenantId;
  readonly actor: AuditActor;
  readonly reason: string;
  readonly escalationId: string;
}

export interface ReopenForCustomerReplyInput {
  readonly ticketId: TicketId;
  readonly tenantId: TenantId;
  readonly eventType: string;
}

export interface ParkForReplyDeliveryFailureInput {
  readonly ticketId: TicketId;
  readonly tenantId: TenantId;
  readonly agentId: AgentId | string;
  readonly tool: string;
  readonly draftInput: unknown;
  readonly error: unknown;
  readonly executionKey: string;
}

export interface ApplyAgentStatusUpdateInput {
  readonly ticketId: TicketId;
  readonly tenantId: TenantId;
  readonly agentId: AgentId | string;
  readonly toStatus: TicketStatus;
  readonly reason?: string;
  readonly expectedFromStatus?: TicketStatus;
  readonly tool: string;
  readonly callId: string;
}

export type TakeOverTicketOutcome =
  | { readonly kind: "taken_over"; readonly canceledApprovals: number }
  | { readonly kind: "ticket_not_found" }
  | { readonly kind: "already_terminal"; readonly status: TicketStatus };

export interface TakeOverTicketInput {
  readonly ticketId: TicketId;
  readonly tenantId: TenantId;
  readonly actor: AuditActor;
  readonly decidedBy: UserId;
  readonly reason: string;
}

export type ResumeTicketOutcome =
  | {
      readonly kind: "resumed";
      readonly toStatus: TicketStatus;
      /**
       * Pending approvals dropped by this resume. Always 0 for a plain
       * hand-back (the bound specialist re-runs, so its proposals stay valid);
       * only a `restartFromTriage` resume cancels them (see below).
       */
      readonly canceledApprovals: number;
    }
  | { readonly kind: "ticket_not_found" }
  | { readonly kind: "not_in_takeover"; readonly status: TicketStatus };

export interface ResumeTicketInput {
  readonly ticketId: TicketId;
  readonly tenantId: TenantId;
  readonly actor: AuditActor;
  /** The manager rejecting any pending approvals a `restartFromTriage` drops. */
  readonly decidedBy: UserId;
  readonly reason: string;
  /**
   * Full retry from triage. The runtime always re-runs `current_agent_id`, so a
   * plain resume re-runs the already-bound specialist and never re-routes. When
   * set, the resume ALSO rebinds the ticket to support-triage and clears the
   * stale `classification` (in the same tx) so the next tick re-classifies and
   * re-routes — the only way a deployed routing change reaches an in-flight,
   * already-routed ticket. Enrichment + the customer's reason (`notes`) are kept,
   * since triage has no message-replay and re-classifies from context.
   *
   * Because triage re-classifies and re-routes from scratch, every pending
   * approval from the old run is stale and is CANCELED in the same tx — a
   * stale approval-link click must not execute the previous route's proposal
   * after the ticket has been sent back through triage.
   */
  readonly restartFromTriage?: boolean;
}

export type SetMerchantStatusOutcome =
  | {
      readonly kind: "updated";
      readonly fromStatus: TicketStatus;
      readonly toStatus: TicketStatus;
      readonly canceledApprovals: number;
    }
  | { readonly kind: "unchanged"; readonly status: TicketStatus }
  | { readonly kind: "invalid_status"; readonly status: string }
  | {
      readonly kind: "transition_not_allowed";
      readonly fromStatus: TicketStatus;
      readonly toStatus: TicketStatus;
    }
  | { readonly kind: "ticket_not_found" };

export interface SetMerchantStatusInput {
  readonly ticketId: TicketId;
  readonly tenantId: TenantId;
  readonly actor: AuditActor;
  readonly decidedBy: UserId;
  readonly toStatus: string;
  readonly reason: string;
}

/**
 * A manager hand-correcting the ticket's customer/order binding from the ticket
 * page (the "pencil" edit on the Customer / Order cards). Rarely needed — only
 * when the agent couldn't extract them (e.g. a legacy relay ticket created before
 * Reply-To parsing, stamped with `mailer@shopify.com`). Only the provided
 * fields are merged into `context`; the rest is untouched. `identifiedOrderId`
 * is the CANONICAL resolved Shopify GID (the caller resolves the merchant's
 * typed ref through `ShopifyService` first, exactly like the runtime does), so
 * this stays inside the canonical-order-binding invariant; `quotedOrderRef`
 * holds the raw string the merchant typed. No status transition — editing
 * details is metadata, not a lifecycle move, so it works in any status.
 */
export interface SetTicketDetailsInput {
  readonly ticketId: TicketId;
  readonly tenantId: TenantId;
  readonly actor: AuditActor;
  /** Corrected customer address; merged into `context.customerEmail`. */
  readonly customerEmail?: string;
  /** Corrected customer display name; merged into `context.customerName`. */
  readonly customerName?: string | null;
  /** Corrected customer phone; merged into `context.customerPhone`. */
  readonly customerPhone?: string | null;
  /** Resolved order GID (present only when the ref resolved in Shopify). */
  readonly identifiedOrderId?: string;
  /** The raw order ref the merchant typed (untrusted hint). */
  readonly quotedOrderRef?: string;
}

export type TicketLifecycleWriterError =
  | ApprovalServiceError
  | TicketRepositoryError
  | AuditLogError
  | IdempotencyStoreDbError
  | ReplyDeliveryError;

export class TicketLifecycleWriter extends Context.Tag("TicketLifecycleWriter")<
  TicketLifecycleWriter,
  {
    readonly escalateToHuman: (
      input: EscalateToHumanInput,
    ) => Effect.Effect<Ticket, TicketLifecycleWriterError>;

    readonly resolve: (
      input: ResolveTicketInput,
    ) => Effect.Effect<Ticket, TicketLifecycleWriterError>;

    readonly parkForApproval: (
      input: ParkForApprovalInput,
    ) => Effect.Effect<ParkForApprovalResult, TicketLifecycleWriterError>;

    readonly queueApproval: (
      input: QueueApprovalInput,
    ) => Effect.Effect<Approval, TicketLifecycleWriterError>;

    readonly parkForApprovalBundle: (
      input: ParkForApprovalBundleInput,
    ) => Effect.Effect<Ticket, TicketLifecycleWriterError>;

    readonly parkWaitingForCustomer: (
      input: ParkForWaitInput,
    ) => Effect.Effect<Ticket, TicketLifecycleWriterError>;

    readonly parkWaitingForSupplier: (
      input: ParkForWaitInput,
    ) => Effect.Effect<Ticket, TicketLifecycleWriterError>;

    readonly parkWaitingForSupplierManually: (
      input: ParkForSupplierManualInput,
    ) => Effect.Effect<ParkForSupplierManualOutcome, TicketLifecycleWriterError>;

    readonly reopenForCustomerReply: (
      input: ReopenForCustomerReplyInput,
    ) => Effect.Effect<Ticket, TicketLifecycleWriterError>;

    readonly parkForReplyDeliveryFailure: (
      input: ParkForReplyDeliveryFailureInput,
    ) => Effect.Effect<Ticket, TicketLifecycleWriterError>;

    readonly applyAgentStatusUpdate: (
      input: ApplyAgentStatusUpdateInput,
    ) => Effect.Effect<Ticket, TicketLifecycleWriterError>;

    readonly takeOver: (
      input: TakeOverTicketInput,
    ) => Effect.Effect<TakeOverTicketOutcome, TicketLifecycleWriterError>;

    readonly resume: (
      input: ResumeTicketInput,
    ) => Effect.Effect<ResumeTicketOutcome, TicketLifecycleWriterError>;

    readonly setMerchantStatus: (
      input: SetMerchantStatusInput,
    ) => Effect.Effect<SetMerchantStatusOutcome, TicketLifecycleWriterError>;

    readonly setTicketDetails: (
      input: SetTicketDetailsInput,
    ) => Effect.Effect<Ticket, TicketLifecycleWriterError>;
  }
>() {}

const auditDetails = (
  reason: string,
  details: LifecycleDetails | undefined,
): LifecycleDetails => ({ reason, ...(details ?? {}) });

const readRiskFlags = (context: TicketContext): ReadonlyArray<string> =>
  Array.isArray(context["riskFlags"])
    ? context["riskFlags"].filter(
        (flag): flag is string => typeof flag === "string",
      )
    : [];

const withRiskFlag = (
  context: TicketContext,
  flag: string,
): TicketContext | null => {
  const current = readRiskFlags(context);
  if (current.includes(flag)) return null;
  return { ...context, riskFlags: [...current, flag] };
};

const withoutRiskFlags = (
  context: TicketContext,
  flagsToClear: ReadonlyArray<string>,
): TicketContext | null => {
  if (flagsToClear.length === 0) return null;
  const clearSet = new Set(flagsToClear);
  const current = readRiskFlags(context);
  const next = current.filter((flag) => !clearSet.has(flag));
  if (next.length === current.length) return null;
  return { ...context, riskFlags: next };
};

const replyDeliveryErrorLabel = (error: unknown): string => {
  const issues = (error as { readonly issues?: unknown } | null)?.issues;
  const errTag = (error as { readonly _tag?: unknown } | null)?._tag;
  return Array.isArray(issues) && issues.length > 0
    ? issues.filter((i): i is string => typeof i === "string").join(",")
    : typeof errTag === "string"
      ? errTag
      : "ConversationSendFailed";
};

const replyDeliveryDraftId = (
  ticketId: TicketId,
  tool: string,
  draftInput: unknown,
): string => {
  const rawDraftId = (draftInput as { readonly draftId?: unknown } | null)
    ?.draftId;
  return typeof rawDraftId === "string" && rawDraftId.length > 0
    ? rawDraftId
    : `${ticketId}:${tool}`;
};

// A ticket should only ever have ONE pending customer-email draft awaiting
// approval: a newly-created draft supersedes any older still-pending one (the
// situation may have changed since the old draft, e.g. a supplier replied). This
// is enforced wherever a reply approval is created (park OR queue), so it holds
// for every agent and path — not just the autonomous loop.
const REPLY_DRAFT_TOOL = "conversation.reply";

const RESUME_TO_STATUS = "in_progress" satisfies TicketStatus;
// The primary/triage agent every ticket is born on. A `restartFromTriage` resume
// rebinds here so the next tick re-classifies + re-routes. Mirrors the runtime's
// hardcoded create-time agent id.
const PRIMARY_AGENT_ID = "support-triage" as AgentId;

const TERMINAL_TAKEOVER_STATUSES: ReadonlySet<TicketStatus> = new Set([
  "resolved",
  "archived",
  "human_takeover",
  "failed",
]);

export const TicketLifecycleWriterLive = Layer.effect(
  TicketLifecycleWriter,
  Effect.gen(function* () {
    const approvals = yield* ApprovalService;
    const tickets = yield* TicketRepository;
    const audit = yield* AuditLogService;
    const tx = yield* TransactionRunner;
    const maybeReplyDelivery = yield* Effect.serviceOption(ReplyDeliveryService);
    const maybeExecutions = yield* Effect.serviceOption(ToolExecutionStore);

    // A new customer-email draft supersedes any older still-pending draft for
    // the same ticket (general "newest draft wins" rule). Runs in the caller's tx
    // BEFORE the new approval is created, so only the latest draft is ever
    // pending. No-op for non-reply tools and when there's nothing to supersede.
    const supersedeOlderDraft = (input: {
      readonly tenantId: TenantId;
      readonly ticketId: TicketId;
      readonly tool: string;
      readonly agentId: AgentId;
    }) =>
      Effect.gen(function* () {
        if (input.tool !== REPLY_DRAFT_TOOL) return;
        const superseded = yield* approvals.supersedePendingForTicket({
          tenantId: input.tenantId,
          ticketId: input.ticketId,
          reason: "superseded by a newer draft",
          tools: [REPLY_DRAFT_TOOL],
        });
        if (superseded > 0) {
          yield* audit.record({
            tenantId: input.tenantId,
            ticketId: input.ticketId,
            actor: { type: "agent", id: input.agentId },
            action: "approval.superseded",
            details: { count: superseded, reason: "newer draft" },
          });
        }
      });

    return TicketLifecycleWriter.of({
      escalateToHuman: (input) =>
        tx.run(
          Effect.gen(function* () {
            const current = yield* tickets.getById(input.ticketId, input.tenantId);
            if (
              input.onlyFromStatus !== undefined &&
              current.status !== input.onlyFromStatus
            ) {
              return current;
            }

            let working = current;
            if (input.riskFlag) {
              const patchedContext = withRiskFlag(
                working.context,
                input.riskFlag,
              );
              if (patchedContext) {
                working = yield* tickets.update(
                  working.id,
                  { context: patchedContext },
                  working.tenantId,
                );
              }
            }

            const updated =
              working.status === "human_takeover"
                ? working
                : yield* tickets.transitionStatus(working.id, "human_takeover", {
                    tenantId: working.tenantId,
                    reason: input.reason,
                  });

            yield* audit.record({
              tenantId: updated.tenantId,
              ticketId: updated.id,
              actor: input.actor,
              action: input.action ?? "ticket.escalated_to_human",
              details: auditDetails(input.reason, input.details),
            });
            return updated;
          }),
        ),

      resolve: (input) =>
        tx.run(
          Effect.gen(function* () {
            let current = yield* tickets.getById(input.ticketId, input.tenantId);
            if (current.status === "resolved" || current.status === "archived") {
              return current;
            }

            // Bypass-proof identity-disclosure backstop (prod 3428f154): an
            // AGENT must never resolve a ticket that still carries an UNVERIFIED
            // order/customer mismatch — we never confirmed who we're talking to,
            // so closing it would swallow a live ticket. This reads the FRESH
            // in-transaction context (not a possibly-stale in-memory copy the
            // runtime's loop guard relies on), so it holds no matter how the
            // resolve was reached. Manual (user) and system resolves are allowed
            // — a human owns that decision.
            const unverifiedMismatch =
              readRiskFlags(current.context).includes(
                "order_customer_mismatch",
              ) && current.context["identityVerified"] !== true;
            if (input.actor.type === "agent" && unverifiedMismatch) {
              const parked = yield* tickets.transitionStatus(
                current.id,
                "human_takeover",
                {
                  tenantId: current.tenantId,
                  reason: "unverified_identity_mismatch_resolve_blocked",
                },
              );
              yield* audit.record({
                tenantId: parked.tenantId,
                ticketId: parked.id,
                actor: { type: "system", id: "ticket-lifecycle-writer" },
                action: "ticket.escalated_to_human",
                details: auditDetails(
                  "unverified_identity_mismatch_resolve_blocked",
                  input.details,
                ),
              });
              return parked;
            }

            if (
              current.status === "human_takeover" &&
              input.bridgeFromHumanTakeover === true
            ) {
              current = yield* tickets.transitionStatus(
                current.id,
                "in_progress",
                {
                  tenantId: current.tenantId,
                  reason: input.reason,
                },
              );
            }

            const patchedContext = withoutRiskFlags(
              current.context,
              input.clearRiskFlags ?? [],
            );
            if (patchedContext) {
              current = yield* tickets.update(
                current.id,
                { context: patchedContext },
                current.tenantId,
              );
            }

            const resolved = yield* tickets.transitionStatus(
              current.id,
              "resolved",
              {
                tenantId: current.tenantId,
                reason: input.reason,
              },
            );
            yield* audit.record({
              tenantId: resolved.tenantId,
              ticketId: resolved.id,
              actor: input.actor,
              action: input.action ?? "ticket.resolved",
              details: auditDetails(input.reason, input.details),
            });
            return resolved;
          }),
        ),

      parkForApproval: (input) =>
        tx.run(
          Effect.gen(function* () {
            yield* supersedeOlderDraft(input);
            // Stamp the approval with the ticket's current round so a later
            // resume (which bumps the epoch) fences this draft out of its
            // bundle — the double-send guard.
            const cur = yield* tickets.getById(input.ticketId, input.tenantId);
            const approval = yield* approvals.create({
              tenantId: input.tenantId,
              ticketId: input.ticketId,
              agentId: input.agentId,
              tool: input.tool,
              proposedInput: input.proposedInput,
              reasoning: input.reasoning,
              riskLevel: input.riskLevel,
              expiresAt: input.expiresAt,
              epoch: cur.epoch ?? 0,
            });
            const row = yield* tickets.transitionStatus(
              input.ticketId,
              "waiting_for_approval",
              {
                tenantId: input.tenantId,
                reason: `tool ${input.tool} pending approval`,
              },
            );
            yield* audit.record({
              tenantId: row.tenantId,
              ticketId: row.id,
              actor: { type: "agent", id: input.agentId },
              action: "ticket.waiting_for_approval",
              details: {
                approvalId: approval.id,
                tool: input.tool,
                turn: input.turn,
              },
            });
            return { approval, ticket_: row };
          }),
        ),

      queueApproval: (input) =>
        tx.run(
          Effect.gen(function* () {
            // Approval row + audit, NO status transition (autonomous loop):
            // the agent keeps acting; the ticket parks once via
            // parkForApprovalBundle when the loop ends.
            yield* supersedeOlderDraft(input);
            // Stamp with the ticket's current round (see parkForApproval).
            const cur = yield* tickets.getById(input.ticketId, input.tenantId);
            const approval = yield* approvals.create({
              tenantId: input.tenantId,
              ticketId: input.ticketId,
              agentId: input.agentId,
              tool: input.tool,
              proposedInput: input.proposedInput,
              reasoning: input.reasoning,
              riskLevel: input.riskLevel,
              expiresAt: input.expiresAt,
              epoch: cur.epoch ?? 0,
            });
            yield* audit.record({
              tenantId: input.tenantId,
              ticketId: input.ticketId,
              actor: { type: "agent", id: input.agentId },
              action: "ticket.action_queued",
              details: {
                approvalId: approval.id,
                tool: input.tool,
                turn: input.turn,
              },
            });
            return approval;
          }),
        ),

      parkForApprovalBundle: (input) =>
        tx.run(
          Effect.gen(function* () {
            const row = yield* tickets.transitionStatus(
              input.ticketId,
              "waiting_for_approval",
              {
                tenantId: input.tenantId,
                reason: `${input.approvalIds.length} action(s) pending approval`,
              },
            );
            yield* audit.record({
              tenantId: row.tenantId,
              ticketId: row.id,
              actor: { type: "agent", id: input.agentId },
              action: "ticket.waiting_for_approval",
              details: {
                bundle: true,
                approvalIds: [...input.approvalIds],
                count: input.approvalIds.length,
                turn: input.turn,
              },
            });
            return row;
          }),
        ),

      parkWaitingForCustomer: (input) =>
        tx.run(
          Effect.gen(function* () {
            const updated = yield* tickets.transitionStatus(
              input.ticketId,
              "waiting_for_customer",
              {
                tenantId: input.tenantId,
                reason: input.tool,
              },
            );
            yield* audit.record({
              tenantId: updated.tenantId,
              ticketId: updated.id,
              actor: { type: "agent", id: input.agentId },
              action: "ticket.waiting_for_customer",
              details: { tool: input.tool, callId: input.callId },
            });
            return updated;
          }),
        ),

      parkWaitingForSupplier: (input) =>
        tx.run(
          Effect.gen(function* () {
            const updated = yield* tickets.transitionStatus(
              input.ticketId,
              "waiting_for_supplier",
              {
                tenantId: input.tenantId,
                reason: input.tool,
              },
            );
            yield* audit.record({
              tenantId: updated.tenantId,
              ticketId: updated.id,
              actor: { type: "agent", id: input.agentId },
              action: "ticket.waiting_for_supplier",
              details: { tool: input.tool, callId: input.callId },
            });
            return updated;
          }),
        ),

      parkWaitingForSupplierManually: (input) =>
        tx.run(
          Effect.gen(function* () {
            let current = yield* tickets.getById(input.ticketId, input.tenantId);

            // Approval stays the primary wait under concurrent waits — the
            // escalation row (written by the caller) carries the supplier
            // wait, so only the audit row lands here.
            if (current.status === "waiting_for_approval") {
              yield* audit.record({
                tenantId: current.tenantId,
                ticketId: current.id,
                actor: input.actor,
                action: "ticket.waiting_for_supplier",
                details: {
                  reason: input.reason,
                  escalationId: input.escalationId,
                  manual: true,
                },
              });
              return { kind: "parked" as const, toStatus: current.status };
            }

            if (current.status === "human_takeover") {
              // Same bridge as resolve: the direct human_takeover →
              // waiting_for_supplier jump is illegal under §10.
              current = yield* tickets.transitionStatus(
                current.id,
                "in_progress",
                {
                  tenantId: current.tenantId,
                  reason: input.reason,
                },
              );
            }

            if (
              !isStatusTransitionAllowed(current.status, "waiting_for_supplier")
            ) {
              return {
                kind: "transition_not_allowed" as const,
                fromStatus: current.status,
              };
            }

            const updated = yield* tickets.transitionStatus(
              current.id,
              "waiting_for_supplier",
              {
                tenantId: current.tenantId,
                reason: input.reason,
              },
            );
            yield* audit.record({
              tenantId: updated.tenantId,
              ticketId: updated.id,
              actor: input.actor,
              action: "ticket.waiting_for_supplier",
              details: {
                reason: input.reason,
                escalationId: input.escalationId,
                manual: true,
              },
            });
            return { kind: "parked" as const, toStatus: updated.status };
          }),
        ),

      reopenForCustomerReply: (input) =>
        tx.run(
          Effect.gen(function* () {
            const current = yield* tickets.getById(
              input.ticketId,
              input.tenantId,
            );
            if (current.status !== "resolved" && current.status !== "archived") {
              return current;
            }
            const row = yield* tickets.transitionStatus(
              current.id,
              "in_progress",
              {
                tenantId: current.tenantId,
                reason: `reopened by ${input.eventType}`,
              },
            );
            yield* audit.record({
              tenantId: row.tenantId,
              ticketId: row.id,
              actor: { type: "system", id: "runtime" },
              action: "ticket.reopened",
              details: { eventType: input.eventType },
            });
            return row;
          }),
        ),

      parkForReplyDeliveryFailure: (input) =>
        tx.run(
          Effect.gen(function* () {
            const current = yield* tickets.getById(
              input.ticketId,
              input.tenantId,
            );
            const errorLabel = replyDeliveryErrorLabel(input.error);
            const draftId = replyDeliveryDraftId(
              current.id,
              input.tool,
              input.draftInput,
            );

            const replyDelivery = Option.getOrUndefined(maybeReplyDelivery);
            if (!replyDelivery) {
              yield* Effect.dieMessage("ReplyDeliveryService unavailable");
            } else {
              yield* replyDelivery.enqueue({
                tenantId: current.tenantId,
                ticketId: current.id,
                agentId: input.agentId,
                tool: input.tool,
                mailbox: current.mailbox ?? null,
                draftId,
                draft: input.draftInput,
                error: errorLabel,
              });
            }

            const patchedContext = withRiskFlag(
              current.context,
              REPLY_DELIVERY_FAILED_FLAG,
            );
            if (patchedContext) {
              yield* tickets.update(
                current.id,
                { context: patchedContext },
                current.tenantId,
              );
            }
            const row = yield* tickets.transitionStatus(
              current.id,
              "human_takeover",
              {
                tenantId: current.tenantId,
                reason: REPLY_DELIVERY_FAILED_FLAG,
              },
            );
            yield* audit.record({
              tenantId: row.tenantId,
              ticketId: row.id,
              actor: { type: "system", id: "agent-runtime" },
              action: "ticket.escalated_to_human",
              details: {
                reason: REPLY_DELIVERY_FAILED_FLAG,
                tool: input.tool,
                error: errorLabel,
              },
            });
            if (Option.isSome(maybeExecutions)) {
              yield* maybeExecutions.value.record({
                tenantId: current.tenantId,
                ticketId: current.id,
                callId: input.executionKey,
                tool: input.tool,
                resultOk: false,
              });
            }
            return row;
          }),
        ),

      applyAgentStatusUpdate: (input) =>
        tx.run(
          Effect.gen(function* () {
            const current = yield* tickets.getById(
              input.ticketId,
              input.tenantId,
            );
            const transitionOpts: {
              readonly tenantId: TenantId;
              readonly reason?: string;
              readonly expectedFromStatus?: TicketStatus;
            } = {
              tenantId: current.tenantId,
              ...(input.reason !== undefined ? { reason: input.reason } : {}),
              ...(input.expectedFromStatus !== undefined
                ? { expectedFromStatus: input.expectedFromStatus }
                : {}),
            };
            const updated = yield* tickets.transitionStatus(
              current.id,
              input.toStatus,
              transitionOpts,
            );
            yield* audit.record({
              tenantId: updated.tenantId,
              ticketId: updated.id,
              actor: { type: "agent", id: input.agentId },
              action: "ticket.status_changed",
              details: {
                reason: input.reason ?? null,
                fromStatus: current.status,
                toStatus: input.toStatus,
                tool: input.tool,
                callId: input.callId,
              },
            });
            return updated;
          }),
        ),

      takeOver: (input) =>
        tx.run(
          Effect.gen(function* () {
            const current = yield* tickets
              .getById(input.ticketId, input.tenantId)
              .pipe(
                Effect.map((ticket_) => ({ _tag: "found" as const, ticket_ })),
                Effect.catchTag("TicketNotFound", () =>
                  Effect.succeed({ _tag: "missing" as const }),
                ),
              );
            if (current._tag === "missing") return { kind: "ticket_not_found" };
            const ticket_ = current.ticket_;
            if (TERMINAL_TAKEOVER_STATUSES.has(ticket_.status)) {
              return {
                kind: "already_terminal",
                status: ticket_.status,
              };
            }

            const updated = yield* tickets.transitionStatus(
              ticket_.id,
              "human_takeover",
              {
                tenantId: ticket_.tenantId,
                reason: input.reason,
              },
            );
            // Bump the round: a human now owns this attempt, so any decision
            // from the prior round is fenced out (recovery hardening).
            yield* tickets.update(
              ticket_.id,
              { epoch: (ticket_.epoch ?? 0) + 1 },
              ticket_.tenantId,
            );
            yield* audit.record({
              tenantId: updated.tenantId,
              ticketId: updated.id,
              actor: input.actor,
              action: "ticket.taken_over",
              details: {
                reason: input.reason,
                fromStatus: ticket_.status,
              },
            });
            const canceledApprovals = yield* approvals.cancelPendingForTicket({
              tenantId: updated.tenantId,
              ticketId: updated.id,
              decidedBy: input.decidedBy,
              decisionReason: "ticket taken over",
            });
            return { kind: "taken_over", canceledApprovals };
          }),
        ),

      resume: (input) =>
        tx.run(
          Effect.gen(function* () {
            const current = yield* tickets
              .getById(input.ticketId, input.tenantId)
              .pipe(
                Effect.map((ticket_) => ({ _tag: "found" as const, ticket_ })),
                Effect.catchTag("TicketNotFound", () =>
                  Effect.succeed({ _tag: "missing" as const }),
                ),
              );
            if (current._tag === "missing") return { kind: "ticket_not_found" };
            const ticket_ = current.ticket_;
            if (ticket_.status !== "human_takeover") {
              return { kind: "not_in_takeover", status: ticket_.status };
            }

            const updated = yield* tickets.transitionStatus(
              ticket_.id,
              RESUME_TO_STATUS,
              {
                tenantId: ticket_.tenantId,
                expectedFromStatus: "human_takeover",
                reason: input.reason,
              },
            );
            // Bump the ticket round on EVERY resume (plain hand-back OR full
            // retry): the new attempt owns a fresh epoch, so approvals + events
            // from the prior attempt are fenced out — an approved-but-skipped
            // draft can't be swept into this round's bundle (the double-send),
            // and a stale decision can't drive this round. Same tx as the flip.
            const newEpoch = (ticket_.epoch ?? 0) + 1;
            let canceledApprovals = 0;
            if (input.restartFromTriage) {
              // Full retry from triage: rebind to the primary agent, drop the
              // stale routing key, and cancel every pending approval so the tick
              // re-classifies + re-routes from scratch and no stale approval-link
              // click acts on the old route's proposal.
              const { classification: _drop, ...keptContext } =
                ticket_.context as Record<string, unknown>;
              yield* tickets.update(
                ticket_.id,
                {
                  currentAgentId: PRIMARY_AGENT_ID,
                  context: keptContext as never,
                  epoch: newEpoch,
                },
                ticket_.tenantId,
              );
              canceledApprovals = yield* approvals.cancelPendingForTicket({
                tenantId: updated.tenantId,
                ticketId: updated.id,
                decidedBy: input.decidedBy,
                decisionReason: "ticket restarted from triage",
              });
            } else {
              yield* tickets.update(
                ticket_.id,
                { epoch: newEpoch },
                ticket_.tenantId,
              );
            }
            yield* audit.record({
              tenantId: updated.tenantId,
              ticketId: updated.id,
              actor: input.actor,
              action: "ticket.resumed",
              details: {
                reason: input.reason,
                fromStatus: ticket_.status,
                restartFromTriage: input.restartFromTriage === true,
              },
            });
            return {
              kind: "resumed",
              toStatus: RESUME_TO_STATUS,
              canceledApprovals,
            };
          }),
        ),

      setMerchantStatus: (input) =>
        tx.run(
          Effect.gen(function* () {
            const current = yield* tickets
              .getById(input.ticketId, input.tenantId)
              .pipe(
                Effect.map((ticket_) => ({ _tag: "found" as const, ticket_ })),
                Effect.catchTag("TicketNotFound", () =>
                  Effect.succeed({ _tag: "missing" as const }),
                ),
              );
            if (current._tag === "missing") return { kind: "ticket_not_found" };
            const ticket_ = current.ticket_;
            if (!isMerchantSettableStatus(input.toStatus)) {
              return { kind: "invalid_status", status: input.toStatus };
            }
            const toStatus = input.toStatus;
            if (ticket_.status === toStatus) {
              return { kind: "unchanged", status: ticket_.status };
            }
            if (!isStatusTransitionAllowed(ticket_.status, toStatus)) {
              return {
                kind: "transition_not_allowed",
                fromStatus: ticket_.status,
                toStatus,
              };
            }

            const updated = yield* tickets.transitionStatus(
              ticket_.id,
              toStatus,
              {
                tenantId: ticket_.tenantId,
                reason: input.reason,
              },
            );
            yield* audit.record({
              tenantId: updated.tenantId,
              ticketId: updated.id,
              actor: input.actor,
              action: "ticket.status_changed",
              details: {
                reason: input.reason,
                fromStatus: ticket_.status,
                toStatus,
              },
            });
            const canceledApprovals = yield* approvals.cancelPendingForTicket({
              tenantId: updated.tenantId,
              ticketId: updated.id,
              decidedBy: input.decidedBy,
              decisionReason: "ticket status changed manually",
            });
            return {
              kind: "updated",
              fromStatus: ticket_.status,
              toStatus,
              canceledApprovals,
            };
          }),
        ),

      setTicketDetails: (input) =>
        tx.run(
          Effect.gen(function* () {
            const current = yield* tickets.getById(input.ticketId, input.tenantId);
            const changed: Array<string> = [];
            const nextContext: Record<string, unknown> = { ...current.context };
            if (input.customerEmail !== undefined) {
              nextContext["customerEmail"] = input.customerEmail;
              changed.push("customerEmail");
            }
            if (
              input.customerName !== undefined &&
              input.customerName !== null
            ) {
              nextContext["customerName"] = input.customerName;
              changed.push("customerName");
            }
            if (
              input.customerPhone !== undefined &&
              input.customerPhone !== null
            ) {
              nextContext["customerPhone"] = input.customerPhone;
              changed.push("customerPhone");
            }
            if (input.identifiedOrderId !== undefined) {
              nextContext["identifiedOrderId"] = input.identifiedOrderId;
              changed.push("identifiedOrderId");
            }
            if (input.quotedOrderRef !== undefined) {
              nextContext["quotedOrderRef"] = input.quotedOrderRef;
              changed.push("quotedOrderRef");
            }
            // Nothing to change — don't write an empty edit or a noise audit row.
            if (changed.length === 0) return current;

            const updated = yield* tickets.update(
              current.id,
              { context: nextContext as TicketContext },
              current.tenantId,
            );
            yield* audit.record({
              tenantId: updated.tenantId,
              ticketId: updated.id,
              actor: input.actor,
              action: "ticket.details_edited",
              details: { changed },
            });
            return updated;
          }),
        ),
    });
  }),
);
