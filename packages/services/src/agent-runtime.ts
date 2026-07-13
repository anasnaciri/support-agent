import { Context, Effect, Either, Layer, Option, Schema } from "effect";
import {
  PermissionService,
  ToolRegistry,
  type AgentConfig,
  type AnyTool,
  type Approval,
  type ApprovalId,
  type ApprovalRiskLevel,
  type TicketChannel,
  type ChatMessage,
  type DomainEvent,
  type InboundMessage,
  type LLMDecision,
  type LLMError,
  type TenantId,
  type Ticket,
  type ThreadId,
  type ToolContext,
  type WorkflowResult,
  primaryWaitStatus,
  summarizePhotoSignals,
  wrapUntrusted,
  UNTRUSTED_PREAMBLE,
  AgentId as makeAgentId,
  TenantId as makeTenantId,
  ThreadId as makeThreadId,
} from "@support-agent/agent-core";
import { TicketRepository } from "./ticket-repository.js";
import { AuditLogService } from "./audit-log.js";
import { ApprovalService } from "./approval-service.js";
import { LLMService } from "./llm-service.js";
import { ShopifyService } from "./shopify-service.js";
import { TransactionRunner } from "./transaction-runner.js";
import { PlatformMailService } from "./platform-mail.js";
import {
  MerchantNotificationService,
  humanTakeoverNotification,
  type MerchantNotification,
} from "./merchant-notification.js";
import { ImageHashStore, type SimilarImageHit } from "./image-hash-store.js";
import { TicketAttachmentStore } from "./ticket-attachments.js";
import { ApprovalLinkConfig } from "./approval-link-config.js";
import {
  buildApprovalNotification,
  buildBundleApprovalNotification,
} from "./approval-notification.js";
import {
  TenantAgentOverridesService,
  type AgentOverride,
} from "./tenant-agent-overrides.js";
import { AgentResolver } from "./agent-resolver.js";
import {
  TenantRepository,
  defaultResolutionPolicy,
  type ResolutionPolicy,
  type TenantSettings,
} from "./tenant-repository.js";
import {
  defaultBlockedSenders,
  isBlockedSender,
} from "./blocked-senders.js";
import { parseRefundAmount } from "./permission-service-live.js";
import {
  ProcessedMessageStore,
  ToolExecutionStore,
} from "./idempotency-store.js";
import { parseThreadId } from "./conversation-thread-id.js";
import { ConversationService } from "./conversation-service.js";
import { KnowledgeBaseService } from "./knowledge-base.js";
import { SupplierEscalationService } from "./supplier-escalation-service.js";
import {
  REPLY_DELIVERY_FAILED_FLAG,
  isReplyDeliverySendFailure,
} from "./reply-delivery.js";
import {
  TicketLifecycleWriter,
  TicketLifecycleWriterLive,
} from "./ticket-lifecycle-writer.js";


// ------------------------------------------------------------
// Pure, side-effect-free helpers live in agent-runtime-helpers.ts.
// Re-exported here so the package's public surface (and existing
// test imports from "./agent-runtime.js") stay unchanged; imported
// by name for use in the Layer below.
// ------------------------------------------------------------
export * from "./agent-runtime-helpers.js";
import {
  eventToTicketLookup,
  buildSystemPrompt,
  buildInitialMessages,
  inboundCustomerEmail,
  inboundCustomerName,
  inboundCustomerPhone,
  renderThreadTranscript,
  shouldPrefetchThread,
  executionKeyFor,
  toolCallTimeoutMs,
  deliveryScopeFor,
  inboundReplyCandidateIds,
  refundAuditDetails,
  toolFailureAuditDetail,
  deriveTickLockKey,
  refundCustomerMismatchFlag,
  readRiskFlags,
  applySelectedScenarioPolicy,
  isScenarioControlledTool,
  applyResolutionAgentEntry,
  SCENARIO_RESOLUTION_AGENT_ID,
  hasUnverifiedOrderMismatch,
  hasTrackingDestinationMismatch,
  normalizeCountryForMatch,
  trackingSnapshotSupersededByOrder,
  orderContextRef,
  orderCustomerMismatchFlag,
  orderIdentityVerificationPatch,
  normalizeEmailForMatch,
  shouldForceReplyApproval,
  riskFor,
  applyOverride,
  specialistsCallableFrom,
  effectiveHandoffIds,
} from "./agent-runtime-helpers.js";

// ============================================================
// Tag
// ============================================================

export class AgentRuntime extends Context.Tag("AgentRuntime")<
  AgentRuntime,
  {
    readonly handleEvent: (
      event: DomainEvent,
    ) => Effect.Effect<WorkflowResult, never>;
  }
>() {}

// ============================================================
// Default layer
// ============================================================

/**
 * Risk-flag prefix for the damaged-product duplicate-photo guard. One flag per
 * OTHER ticket a near-identical photo was seen on. Shared by the ingestion-time
 * detection and the order-scoped reconcile that runs once the order is known.
 */
const DUPLICATE_PHOTO_FLAG_PREFIX = "duplicate_photo_seen_in_ticket_";
const TRACKING_OUTCOME_RISK_FLAGS = new Set([
  "tracking_destination_mismatch",
  "tracking_destination_unavailable",
  "tracking_lookup_failed",
]);

const supplierDisabledForSelectedScenario = (
  policy: ResolutionPolicy,
  context: Readonly<Record<string, unknown>>,
): boolean => {
  const key = context["scenarioKey"];
  if (typeof key !== "string") return false;
  return policy.scenarios.some(
    (scenario) => scenario.key === key && scenario.supplierMode === "none",
  );
};

const AgentRuntimeLayer = Layer.effect(
  AgentRuntime,
  Effect.gen(function* () {
    const tickets = yield* TicketRepository;
    const audit = yield* AuditLogService;
    // Persists where a customer's inbound files live. Required (not optional
    // like ImageHashStore): the event payload holding their storage keys is
    // never stored, so a missing layer would silently orphan every blob the
    // connector uploads.
    const attachmentStore = yield* TicketAttachmentStore;
    // Tenant-aware resolution: built-in agents first, then the tenant's
    // merchant-authored custom agents. Replaces direct AgentRegistry lookups so
    // a custom agent runs (and a deleted/disabled one fails safe to takeover).
    const resolver = yield* AgentResolver;
    const tools = yield* ToolRegistry;
    const perms = yield* PermissionService;
    const approvals = yield* ApprovalService;
    const llm = yield* LLMService;
    const shopify = yield* ShopifyService;
    const tx = yield* TransactionRunner;
    const lifecycle = yield* TicketLifecycleWriter;
    const mail = yield* PlatformMailService;
    const linkConfig = yield* ApprovalLinkConfig;
    const overrides = yield* TenantAgentOverridesService;
    const tenantRepo = yield* TenantRepository;
    // Default wall-clock bound for a tool call that declares no `timeout`;
    // resolved once so both the in-loop and approval-resume tool paths close
    // over it. Stops a hung connector call from pinning the tick.
    const defaultToolTimeoutMs = toolCallTimeoutMs(process.env);
    // Optional — like ImageHashStore below. Present in the worker (which wires
    // KnowledgeBaseServiceLive); absent in the many runtime test layers that
    // don't, in which ticket the knowledge-base title header is simply omitted.
    // The `knowledge.search` tool resolves the service itself at execute time.
    const maybeKnowledge = yield* Effect.serviceOption(KnowledgeBaseService);
    // Optional — captured at layer-build time so `tick` can close over it.
    // Present in the worker (which wires ImageHashStoreLive); absent in the
    // many test layers that don't, in which ticket duplicate-photo detection
    // is simply skipped.
    const maybeImageHashStore = yield* Effect.serviceOption(ImageHashStore);
    // Optional conversation connector. Present in the worker (which wires a
    // ConversationRouter); absent in lean test layers. Used ONLY to pre-fetch
    // the thread on a `ticket.resumed` tick so the resumed agent (esp. triage,
    // which lacks the conversation.fetch_thread tool) sees the whole
    // conversation + what was already done. Strictly best-effort — a fetch
    // failure must never break a resume.
    const maybeConversation = yield* Effect.serviceOption(ConversationService);
    // Optional idempotency stores (audit C2/C3) — present in the worker,
    // absent in lean test layers (which then skip the dedup, as before).
    const maybeProcessed = yield* Effect.serviceOption(ProcessedMessageStore);
    const maybeExecutions = yield* Effect.serviceOption(ToolExecutionStore);
    // Optional supplier-escalation service. Present in the worker (which wires
    // SupplierEscalationServiceLive); absent in lean test layers. Consulted on
    // an approval resume to detect a STILL-OPEN escalation the just-approved
    // bundle didn't itself create (concurrent wait states) — absent/erroring
    // service degrades to `false` (the old resolve-if-no-escalate behavior).
    const maybeSupplierEscalation = yield* Effect.serviceOption(
      SupplierEscalationService,
    );
    // Optional merchant push channel (Telegram, …) — present when the
    // deployment wires one; absent in lean test layers. Strictly
    // best-effort: a ping must never change a tick's outcome.
    const maybeNotifications = yield* Effect.serviceOption(
      MerchantNotificationService,
    );
    // Best-effort merchant ping. Swallows every failure and runs OUTSIDE
    // any SQL transaction (audit D6 — external HTTP never shares a tx).
    const notifyMerchant = (
      tenantId: TenantId,
      notification: MerchantNotification,
    ): Effect.Effect<void> =>
      Option.isSome(maybeNotifications)
        ? maybeNotifications.value
            .notify(tenantId, notification)
            .pipe(Effect.ignore)
        : Effect.void;

    const stampTrackingLookup = (
      ticket: Pick<Ticket, "id" | "context">,
      toolName: string,
      result: { readonly _tag: "Right" | "Left"; readonly right?: unknown },
    ) => {
      // `order.update_tracking` replaces the number on the Shopify
      // fulfillment — a liveTrackingStatus snapshot describing the OLD number
      // (and its scans) is superseded and must not keep feeding the facts
      // header and the dashboard Tracking card (prod ticket 03649e6f: the
      // card showed a reshipped parcel's old exception forever). Clear it;
      // the next tracking.lookup re-stamps for the new number. A re-store of
      // the SAME number leaves the still-accurate snapshot alone.
      if (toolName === "order.update_tracking") {
        if (result._tag !== "Right") return Effect.succeed(null);
        const stored =
          result.right && typeof result.right === "object"
            ? (result.right as Record<string, unknown>)["trackingNumber"]
            : null;
        const fulfillmentId =
          result.right && typeof result.right === "object"
            ? (result.right as Record<string, unknown>)["fulfillmentId"]
            : null;
        const snapshot = ticket.context["liveTrackingStatus"];
        const snapshotNumber =
          snapshot && typeof snapshot === "object"
            ? (snapshot as Record<string, unknown>)["trackingNumber"]
            : null;
        const nextContext = { ...ticket.context };
        if (typeof fulfillmentId === "string" && fulfillmentId.length > 0) {
          nextContext["trackingFulfillmentId"] = fulfillmentId;
        }
        if (
          snapshot !== undefined &&
          !(typeof stored === "string" && stored === snapshotNumber)
        ) {
          delete nextContext["liveTrackingStatus"];
        }
        if (
          nextContext["trackingFulfillmentId"] ===
            ticket.context["trackingFulfillmentId"] &&
          nextContext["liveTrackingStatus"] === snapshot
        ) {
          return Effect.succeed(null);
        }
        return tickets.update(ticket.id, { context: nextContext });
      }
      if (toolName !== "tracking.lookup") return Effect.succeed(null);
      const { liveTrackingStatus: _liveTrackingStatus, ...rest } =
        ticket.context;
      // Tracking-destination guard: when the carrier's recipient country for
      // this lookup disagrees with the order's shipping country
      // (`orderShipCountry`, stamped from a prior get_order), the tracking
      // number probably belongs to a DIFFERENT order. Persist exactly one
      // tracking outcome: confirmed mismatch, unavailable comparison data, or
      // failed/no-provider lookup. Each fresh lookup replaces the prior tracking
      // outcome while preserving unrelated flags. Only a confirmed mismatch
      // force-gates replies/final messages; the other outcomes have their own
      // dashboard labels and follow the agent's unavailable-tracking guidance.
      const lookupResult =
        result._tag === "Right" &&
        result.right &&
        typeof result.right === "object"
          ? (result.right as Record<string, unknown>)
          : null;
      const destination = normalizeCountryForMatch(
        lookupResult?.["destinationCountry"],
      );
      const orderCountry = normalizeCountryForMatch(rest["orderShipCountry"]);
      const trackingOutcomeFlag =
        result._tag === "Left" || lookupResult?.["kind"] === "no_provider"
          ? "tracking_lookup_failed"
          : lookupResult?.["kind"] === "live" &&
              (destination === null || orderCountry === null)
            ? "tracking_destination_unavailable"
            : destination !== null &&
                orderCountry !== null &&
                destination !== orderCountry
              ? "tracking_destination_mismatch"
              : null;
      const existingFlags = readRiskFlags(rest);
      const flagsWithoutPriorTrackingOutcome = existingFlags.filter(
        (flag) => !TRACKING_OUTCOME_RISK_FLAGS.has(flag),
      );
      const nextFlags = trackingOutcomeFlag
        ? [...flagsWithoutPriorTrackingOutcome, trackingOutcomeFlag]
        : flagsWithoutPriorTrackingOutcome;
      const flagPatch =
        nextFlags.length === existingFlags.length &&
        nextFlags.every((flag, index) => flag === existingFlags[index])
          ? {}
          : { riskFlags: nextFlags };
      return tickets.update(ticket.id, {
        context: {
          ...rest,
          ...(result._tag === "Right"
            ? { liveTrackingStatus: result.right }
            : {}),
          ...flagPatch,
        },
      });
    };

    // `applyOverride` (a pure module-level helper, defined above) overlays the
    // per-(tenant, agent) override row onto the in-code AgentConfig before each
    // turn — model, appended system prompt, and per-tool permission toggles.

    const tickBody = (
      event: DomainEvent,
      // Settings already loaded by `tick`'s blocked-senders gate (only for
      // message.received) — passed through so an inbound tick doesn't read
      // the tenants row twice. Null ⇒ load lazily below, as before.
      preloadedSettings: TenantSettings | null = null,
    ): Effect.Effect<WorkflowResult, never> =>
      Effect.gen(function* () {
        const lookup = eventToTicketLookup(event);
        if (!lookup) {
          return {
            type: "Failed",
            reason: `event type ${event.type} not yet supported`,
            retryable: false,
          } as const;
        }

        // 1+2. Load/create ticket and audit event arrival in one tx
        // (master-plan §4 invariant: event → ticket write must be atomic
        // with audit). Subsequent per-turn writes happen outside this tx;
        // a fully transactional tick is deferred until we can scope an LLM
        // call outside the SQL tx without holding a connection open.
        const { row: ticketRow, wasCreated } = yield* tx.run(
          Effect.gen(function* () {
            let row;
            let wasCreated = false;
            if (lookup.kind === "load") {
              row = yield* tickets.getById(lookup.ticketId as never);
            } else if (lookup.kind === "create") {
              row = yield* tickets.create({
                tenantId: lookup.tenantId as never,
                channel: lookup.channel,
                currentAgentId: makeAgentId("support-triage"),
                subject: lookup.subject,
              });
              wasCreated = true;
            } else {
              // loadOrCreateByThread: connector-driven inbound message.
              // The thread is the natural correlation key; a duplicate
              // `message.received` from a retried Pub/Sub push finds the
              // same ticket and just appends another tick (Audit log will
              // show double `event.received` but no double-create).
              const existing = yield* tickets.findByThreadId(
                makeTenantId(lookup.tenantId),
                makeThreadId(lookup.threadId),
                // Scope by the connector that owns the thread (audit D2)
                // so cross-provider threadId collisions can't correlate.
                parseThreadId(lookup.threadId)?.provider,
                lookup.mailbox,
              );
              if (existing) {
                row = existing;
              } else {
                // The derived thread-id didn't exact-match. Before minting a
                // new ticket, correlate by the message-id index: the reply's
                // In-Reply-To / References point at a message we already
                // recorded for some ticket (a prior inbound, or our own outbound
                // reply). This is what keeps a reply whose client reordered or
                // dropped the `References` chain from splitting off a duplicate
                // ticket (the IMAP `references[0]` thread-root is unreliable).
                const candidateIds =
                  event.type === "message.received"
                    ? inboundReplyCandidateIds(event.payload)
                    : [];
                const byMessageId =
                  candidateIds.length > 0
                    ? yield* tickets.findByMessageIds(
                        makeTenantId(lookup.tenantId),
                        candidateIds,
                      )
                    : null;
                if (byMessageId) {
                  // Attach to the existing ticket; keep its stored threadId so
                  // outbound replies keep threading through the original root.
                  row = byMessageId;
                } else {
                  row = yield* tickets.create({
                    tenantId: makeTenantId(lookup.tenantId),
                    channel: lookup.channel,
                    currentAgentId: makeAgentId("support-triage"),
                    subject: lookup.subject,
                    threadId: makeThreadId(lookup.threadId),
                    mailbox: lookup.mailbox ?? null,
                  });
                  wasCreated = true;
                }
              }
            }
            yield* audit.record({
              tenantId: row.tenantId,
              ticketId: row.id,
              actor: { type: "system", id: "runtime" },
              action: "event.received",
              details: { eventType: event.type },
            });
            // Index this inbound message id so a later reply that cites it —
            // even one whose own References never reach the thread root —
            // resolves back to this ticket. Best-effort: a recording hiccup must
            // not roll back the ticket create + audit it shares this tx with.
            if (
              (event.type === "message.received" ||
                event.type === "customer.replied") &&
              event.payload.messageId
            ) {
              yield* tickets
                .recordMessageId({
                  tenantId: row.tenantId,
                  ticketId: row.id,
                  messageId: event.payload.messageId,
                  direction: "inbound",
                })
                .pipe(Effect.catchAll(() => Effect.void));
            }
            // Index the files the customer sent. The connector already uploaded
            // the bytes and put their storage keys on the payload; this is the
            // first moment they can be tied to a ticket, and the ONLY place
            // that mapping is ever persisted (the event payload is not stored,
            // and a fresh thread fetch cannot recompute the keys — Gmail's
            // per-message attachmentId is not stable across fetches). Without
            // it the blobs are unreachable forever. Best-effort, like
            // recordMessageId: an indexing hiccup must not roll back the ticket
            // create + audit it shares this tx with. Idempotent on the storage
            // key, so a redelivered push re-indexes nothing.
            if (
              (event.type === "message.received" ||
                event.type === "customer.replied") &&
              event.payload.attachments.length > 0
            ) {
              yield* attachmentStore
                .recordInbound(
                  event.payload.attachments.map((a) => ({
                    tenantId: row.tenantId,
                    ticketId: row.id,
                    source: "inbound" as const,
                    filename: a.filename,
                    contentType: a.contentType,
                    sizeBytes: a.sizeBytes,
                    storageKey: a.storageKey,
                    uploadedBy: null,
                    messageId: event.payload.messageId ?? null,
                  })),
                )
                .pipe(Effect.catchAll(() => Effect.void));
            }
            return { row, wasCreated };
          }),
        );

        let working = ticketRow;

        // Park the ticket in `human_takeover` with an audit row, in one tx.
        // Every path that returns `HumanTakeoverRequired` must leave the
        // ticket durably parked (audit L4) — a result the worker merely logs
        // is invisible to the dashboard and the ticket dangles forever.
        const escalateToHuman = (
          ticketId: typeof working.id,
          reason: string,
          details: Record<string, unknown> = {},
        ) =>
          Effect.gen(function* () {
            const updated = yield* lifecycle.escalateToHuman({
              ticketId,
              tenantId: working.tenantId,
              actor: { type: "system", id: "agent-runtime" },
              reason,
              details,
            });
            // Ping the merchant AFTER the park committed (and outside the
            // tx): the ticket just became theirs.
            yield* notifyMerchant(
              updated.tenantId,
              humanTakeoverNotification({
                ticketId: updated.id,
                subject: updated.subject,
                reason,
              }),
            );
            return updated;
          });

        // Index the RFC Message-ID of an outbound customer reply so a later
        // inbound reply that cites it (In-Reply-To / References) correlates
        // back to this ticket — even when the customer's client truncates the
        // `References` chain to just our message and the derived thread-root
        // no longer matches. Best-effort: a recording failure never fails the
        // send (the customer already got the email). `conversation.reply` /
        // `ask_customer` return `{ id, threadId, sentAt }`; the dedup short-
        // circuit returns `{ deduped: true }`, which has no `id` and is skipped.
        const recordOutboundReplyId = (
          ticketRow: typeof working,
          toolName: string,
          result: unknown,
        ): Effect.Effect<void> =>
          Effect.gen(function* () {
            if (
              toolName !== "conversation.reply" &&
              toolName !== "conversation.ask_customer"
            ) {
              return;
            }
            const id = (result as { readonly id?: unknown } | null)?.id;
            if (typeof id !== "string" || id.length === 0) return;
            yield* tickets
              .recordMessageId({
                tenantId: ticketRow.tenantId,
                ticketId: ticketRow.id,
                messageId: id,
                direction: "outbound",
              })
              .pipe(Effect.catchAll(() => Effect.void));
          });

        // Add a single risk-flag to the ticket context (deduped), best-effort:
        // a write failure degrades to the unchanged row rather than aborting.
        const addRiskFlag = (row: typeof working, flag: string) =>
          Effect.gen(function* () {
            const existing = readRiskFlags(row.context);
            if (existing.includes(flag)) return row;
            return yield* tickets
              .update(row.id, {
                context: { ...row.context, riskFlags: [...existing, flag] } as never,
              })
              .pipe(Effect.catchAll(() => Effect.succeed(row)));
          });

        // A customer-reply (`conversation.reply` / `ask_customer`) send FAILED.
        // Don't lose it and don't let the ticket resolve as if it went out:
        //   1. persist the verbatim draft into the reply-delivery outbox so the
        //      worker sweep + the dashboard "Retry sending email" button can
        //      re-send the SAME email (no LLM re-run);
        //   2. stamp the `reply_delivery_failed` risk flag so the dashboard
        //      shows it + the merchant knows the customer wasn't reached;
        //   3. park the ticket in `human_takeover` (NEEDS ATTENTION, never
        //      resolved) — a successful retry later auto-resolves it.
        // All recovery writes succeed together. If the durable draft capture
        // fails, the tick fails retryably so the worker can redeliver instead
        // of parking a ticket with no resend path.
        const parkForReplyDeliveryFailure = (
          ticketRow: typeof working,
          agentId: string,
          toolName: string,
          draftInput: unknown,
          errLeft: unknown,
          executionKey: string,
        ) =>
          Effect.gen(function* () {
            const updated = yield* lifecycle.parkForReplyDeliveryFailure({
              ticketId: ticketRow.id,
              tenantId: ticketRow.tenantId,
              agentId,
              tool: toolName,
              draftInput,
              error: errLeft,
              executionKey,
            });
            yield* notifyMerchant(
              updated.tenantId,
              humanTakeoverNotification({
                ticketId: updated.id,
                subject: updated.subject,
                reason: REPLY_DELIVERY_FAILED_FLAG,
              }),
            );
          });

        // 2.5. Approval-resume short-circuit. `approval.approved` and
        // `approval.rejected` are NOT routed through the agent loop —
        // they execute (or escalate) the previously-gated tool directly.
        // The agent's contribution was made when it proposed the tool
        // call; running the prompt again would just re-invent that work
        // and risk drifting the input from what the manager approved.
        //
        // Assumption today: gated tools are TERMINAL — once they run
        // (e.g. `conversation.reply` sends a customer-facing message),
        // the agent's job is done and the ticket resolves. When a gated
        // tool is mid-workflow (`refund.create` followed by a reply),
        // widen this branch to push the tool result into a fresh tick
        // and re-enter the agent loop.
        // Execute ONE approved approval row: re-validate the input, re-check
        // policy (deny-only), dedup, run the tool, audit. Returns a terminal
        // WorkflowResult on any problem (so bundle resume STOPS and the ticket
        // parks for a human), or `{ ok, tool, result }` on success — the ticket is
        // NOT resolved here. The caller decides the ticket outcome once every
        // approved row has run (and never while other rows are still pending).
        const executeOneApproval = (
          approval: Approval,
          event: Extract<DomainEvent, { type: "approval.approved" }>,
        ): Effect.Effect<
          | WorkflowResult
          | { readonly ok: true; readonly tool: string; readonly result: unknown },
          unknown
        > =>
          Effect.gen(function* () {
            const toolToRun = yield* tools.tryGet(approval.tool);
            if (!toolToRun) {
              yield* escalateToHuman(working.id, "approved_tool_unavailable", {
                approvalId: approval.id,
                tool: approval.tool,
              });
              return {
                type: "HumanTakeoverRequired",
                reason: "approved_tool_unavailable",
              } as const;
            }
            // Input validation (audit L8): `approvedInput` is manager-edited
            // JSON from the dashboard and `proposedInput` may be days old —
            // both must decode against the tool's schema before execute.
            const rawToolInput =
              approval.approvedInput ?? approval.proposedInput;
            const decodedInput = Schema.decodeUnknownEither(
              toolToRun.inputSchema as Schema.Schema<unknown>,
            )(rawToolInput);
            if (Either.isLeft(decodedInput)) {
              yield* escalateToHuman(working.id, "approval_input_invalid", {
                approvalId: approval.id,
                tool: approval.tool,
                issue: String(decodedInput.left.message).slice(0, 500),
              });
              return {
                type: "HumanTakeoverRequired",
                reason: "approval_input_invalid",
              } as const;
            }
            const approvalResolutionPolicy =
              (
                yield* tenantRepo
                  .getSettings(working.tenantId)
                  .pipe(Effect.catchAll(() => Effect.succeed(null)))
              )?.resolutionPolicy ?? defaultResolutionPolicy;
            if (
              toolToRun.name === "supplier.escalate" &&
              supplierDisabledForSelectedScenario(
                approvalResolutionPolicy,
                working.context,
              )
            ) {
              yield* escalateToHuman(
                working.id,
                "scenario_supplier_disabled",
                { approvalId: approval.id, tool: approval.tool },
              );
              return {
                type: "HumanTakeoverRequired",
                reason: "scenario_supplier_disabled",
              } as const;
            }
            // Policy re-check (audit L8): the approval can be acted on days
            // later — if the tenant has since hard-denied the tool (e.g.
            // refund mode flipped to always_deny, scope revoked), the manager's
            // earlier yes must not override the newer policy. Only `deny`
            // blocks; `ask` was satisfied by the manager's decision.
            const resumeOverrides = yield* overrides
              .getForTenant(working.tenantId)
              .pipe(
                Effect.catchAll(() =>
                  Effect.succeed(
                    new Map() as ReadonlyMap<AgentConfig["id"], AgentOverride>,
                  ),
                ),
              );
            const resumeAgent = Option.fromNullable(
              yield* resolver.tryResolve(working.tenantId, approval.agentId),
            );
            if (Option.isSome(resumeAgent)) {
              const effectiveResumeAgent = applySelectedScenarioPolicy(
                applyOverride(resumeAgent.value, resumeOverrides),
                approvalResolutionPolicy,
                working.context,
              );
              const recheck = yield* perms.check({
                tenantId: working.tenantId,
                agent: effectiveResumeAgent,
                tool: toolToRun,
                payload: decodedInput.right,
                ticketId: working.id,
              });
              if (recheck === "deny") {
                yield* escalateToHuman(
                  working.id,
                  "approval_denied_by_policy",
                  { approvalId: approval.id, tool: approval.tool },
                );
                return {
                  type: "HumanTakeoverRequired",
                  reason: "approval_denied_by_policy",
                } as const;
              }
            }
            const callId = `approval-${approval.id}`;
            const toolInput = decodedInput.right;
            // C2: consult the execution marker BEFORE running the tool.
            // pg-boss is at-least-once — a crash after the tool tx but
            // before job completion re-delivers this event, and without
            // the marker the gated tool (a refund, a customer email)
            // executes twice. The key is input-derived when the tool
            // declares an idempotencyKey, so even a second approval row
            // for the same draft dedupes.
            const executionKey = executionKeyFor(
              toolToRun,
              toolInput,
              callId,
              `appr:${approval.id}`,
            );
            const priorMarker = Option.isSome(maybeExecutions)
              ? yield* maybeExecutions.value
                  .find(working.id, executionKey)
                  .pipe(Effect.catchAll(() => Effect.succeed(null)))
              : null;
            if (priorMarker && priorMarker.resultOk === false) {
              // The original execution failed and that run already parked
              // the ticket; nothing to redo here.
              return {
                type: "HumanTakeoverRequired",
                reason: `approved tool ${approval.tool} failed`,
              } as const;
            }
            const ctx: ToolContext = {
              tenantId: working.tenantId,
              ticketId: working.id,
              ...(working.mailbox ? { mailbox: working.mailbox } : {}),
              agentId: approval.agentId,
              callId,
              attemptNumber: 1,
            };
            // The external side effect runs OUTSIDE the SQL tx (audit D6);
            // the audit row + execution marker then commit together. The
            // tool's declared timeout — or the default bound — is honored here
            // too (audit L15).
            const rawResumeEffect = toolToRun.execute(
              toolInput,
              ctx,
            ) as unknown as Effect.Effect<unknown, unknown, never>;
            const resumeEffect = rawResumeEffect.pipe(
              Effect.timeout(toolToRun.timeout ?? defaultToolTimeoutMs),
            );
            let exec: { readonly _tag: "Right" | "Left"; readonly right?: unknown; readonly left?: unknown };
            if (priorMarker) {
              // Already executed successfully in a prior delivery — skip
              // the side effect, continue the bundle.
              yield* tx.run(
                audit.record({
                  tenantId: working.tenantId,
                  ticketId: working.id,
                  actor: { type: "system", id: "runtime" },
                  action: "tool.execution_deduped",
                  details: {
                    tool: approval.tool,
                    executionKey,
                    viaApprovalId: approval.id,
                  },
                }),
              );
              exec = { _tag: "Right", right: { deduped: true } };
            } else {
              const result = yield* resumeEffect.pipe(Effect.either);
              const updatedTrackingTicket = yield* tx.run(
                Effect.gen(function* () {
                  yield* audit.record({
                    tenantId: working.tenantId,
                    ticketId: working.id,
                    actor: { type: "user", id: event.managerId },
                    action: "tool.invoked",
                    details: {
                      tool: approval.tool,
                      callId,
                      ok: result._tag === "Right",
                      viaApprovalId: approval.id,
                      ...refundAuditDetails(approval.tool, toolInput),
                      ...(result._tag === "Left"
                        ? toolFailureAuditDetail(result.left)
                        : {}),
                    },
                  });
                  // Marker shares the tx with the audit row (audit C2):
                  // both commit or neither does.
                  const deferFailedReplyMarker =
                    result._tag === "Left" &&
                    isReplyDeliverySendFailure(approval.tool, result.left);
                  if (
                    Option.isSome(maybeExecutions) &&
                    !deferFailedReplyMarker
                  ) {
                    yield* maybeExecutions.value
                      .record({
                        tenantId: working.tenantId,
                        ticketId: working.id,
                        callId: executionKey,
                        tool: approval.tool,
                        resultOk: result._tag === "Right",
                      })
                      .pipe(Effect.catchAll(() => Effect.void));
                  }
                  return yield* stampTrackingLookup(
                    working,
                    approval.tool,
                    result,
                  );
                }),
              );
              if (updatedTrackingTicket) working = updatedTrackingTicket;
              exec = result;
            }
            // The decision has now been ACTED ON (executed, deduped, or about to
            // be parked on failure). Retire it so a later bundle can't re-run it
            // and the maintenance sweep can't re-publish it (recovery hardening).
            yield* approvals
              .markResumed(approval.id, working.tenantId)
              .pipe(Effect.catchAll(() => Effect.void));
            if (exec._tag === "Left") {
              // Tool failed AFTER approval — park the ticket in human_takeover
              // so someone can intervene. The approval row is already
              // approved, which is the right audit shape (the manager said
              // yes; the platform tried; the platform failed). Without the
              // transition the ticket dangles in `waiting_for_approval` with no
              // pending row and nothing surfaces the failure (audit L4).
              //
              // A customer-reply SEND failure is special: the approved draft is
              // captured into the reply-delivery outbox (so the worker sweep + the
              // dashboard "Retry sending email" button can re-send the SAME email)
              // and the ticket is flagged `reply_delivery_failed` — otherwise it's a
              // generic `approved_tool_failed` escalation.
              if (isReplyDeliverySendFailure(approval.tool, exec.left)) {
                yield* parkForReplyDeliveryFailure(
                  working,
                  approval.agentId,
                  approval.tool,
                  toolInput,
                  exec.left,
                  executionKey,
                );
              } else {
                yield* escalateToHuman(working.id, "approved_tool_failed", {
                  approvalId: approval.id,
                  tool: approval.tool,
                });
              }
              return {
                type: "HumanTakeoverRequired",
                reason: `approved tool ${approval.tool} failed`,
              } as const;
            }
            // The approved reply went out — index its Message-ID for correlation
            // of the customer's eventual reply (best-effort, no-op otherwise).
            yield* recordOutboundReplyId(working, approval.tool, exec.right);
            return { ok: true as const, tool: approval.tool, result: exec.right };
          });

        const resumeApprovedTool = (
          event: Extract<DomainEvent, { type: "approval.approved" }>,
        ) =>
          Effect.gen(function* () {
            const trigger = yield* approvals
              .getById(event.approvalId, working.tenantId)
              .pipe(
              Effect.catchTag("ApprovalNotFound", () =>
                Effect.succeed(null),
              ),
              Effect.catchAll(() => Effect.succeed(null)),
            );
            if (!trigger) {
              return {
                type: "Failed",
                reason: `approval ${event.approvalId} not found`,
                retryable: false,
              } as const;
            }
            // A manager takeover means the human owns the ticket now. Approval
            // events can arrive late or race with takeover/reject/manual-status
            // actions; never let a stale approval execute tools or try to move
            // the ticket out from under the human.
            if (working.status === "human_takeover") {
              yield* tx.run(
                audit.record({
                  tenantId: working.tenantId,
                  ticketId: working.id,
                  actor: { type: "system", id: "runtime" },
                  action: "approval.stale_delivery_skipped",
                  details: {
                    approvalId: trigger.id,
                    status: working.status,
                  },
                }),
              );
              // H1: neutralize the skipped decision. Left `approved`, it would
              // otherwise be swept into a LATER round's bundle (the double-send)
              // and re-published by the maintenance sweep. Marking it resumed
              // retires it for good — the human owns the ticket now.
              yield* approvals
                .markResumed(trigger.id, working.tenantId)
                .pipe(Effect.catchAll(() => Effect.void));
              return { type: "PausedForHumanTakeover" } as const;
            }
            // Duplicate-delivery guard (audit C2): pg-boss is at-least-once.
            // A re-delivered `approval.approved` for a ticket that already ran
            // to completion must NOT execute the gated tool(s) a second time —
            // that's a double refund / double customer email.
            if (working.status === "resolved" || working.status === "archived") {
              yield* tx.run(
                audit.record({
                  tenantId: working.tenantId,
                  ticketId: working.id,
                  actor: { type: "system", id: "runtime" },
                  action: "approval.duplicate_delivery_skipped",
                  details: { approvalId: trigger.id },
                }),
              );
              return { type: "Completed" } as const;
            }
            // Bundle resume (slice 4d): the autonomous loop can queue SEVERAL
            // gated actions on one ticket, all approved together — one
            // `approval.approved` event executes the whole bundle. Gather every
            // already-approved row for the ticket and run them in creation order
            // (= the order the agent proposed them). The legacy single-approval
            // path is just a bundle of one. Each row's own execution marker
            // keeps a redelivery idempotent; the first failure parks the ticket
            // and STOPS the bundle (the rest don't run).
            const all = yield* approvals
              .listForTicket(working.tenantId, working.id)
              .pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<Approval>)));
            // H2: run only the CURRENT round's not-yet-resumed approved rows.
            // An `approved` leftover from a prior attempt (a lower epoch) or one
            // already acted on (`resumedAt`) must never execute here — that is
            // the double-send: a stale approved reply swept into a new round's
            // bundle. Fencing by (epoch, resumedAt) makes it impossible.
            const currentEpoch = working.epoch ?? 0;
            // A row belongs to THIS bundle only if it's an observed-approved,
            // not-yet-resumed row of the CURRENT round.
            const isCurrentBundleRow = (a: Approval): boolean =>
              a.status === "approved" &&
              (a.resumedAt ?? null) === null &&
              (a.epoch ?? 0) === currentEpoch;
            const approvedRows = all.filter(isCurrentBundleRow);
            let bundle = approvedRows;
            let usedFallback = false;
            if (bundle.length === 0) {
              // No observed-approved current row. First: is the TRIGGER itself
              // stale — from a prior round (lower epoch) or already acted on?
              // Such an event is a replay (at-least-once delivery / the
              // maintenance sweep). IGNORE it — do NOT escalate (forcing
              // human_takeover here was the spurious-takeover bug).
              const triggerStale =
                (trigger.resumedAt ?? null) !== null ||
                (trigger.epoch ?? 0) !== currentEpoch;
              if (triggerStale) {
                yield* tx.run(
                  audit.record({
                    tenantId: working.tenantId,
                    ticketId: working.id,
                    actor: { type: "system", id: "runtime" },
                    action: "approval.ignored_stale",
                    details: {
                      approvalId: trigger.id,
                      event: "approval.approved",
                      status: trigger.status,
                      reason:
                        (trigger.resumedAt ?? null) !== null
                          ? "already_resumed"
                          : "stale_epoch",
                      epoch: trigger.epoch ?? 0,
                      ticketEpoch: currentEpoch,
                    },
                  }),
                );
                return { type: "Completed" } as const;
              }
              // Current-round trigger, but terminally decided (rejected /
              // cancelled / expired): nothing to run — park for a human
              // (unchanged behavior).
              if (
                trigger.status === "rejected" ||
                trigger.status === "cancelled" ||
                trigger.status === "expired"
              ) {
                yield* escalateToHuman(working.id, "approval_not_runnable", {
                  approvalId: trigger.id,
                  status: trigger.status,
                });
                return {
                  type: "HumanTakeoverRequired",
                  reason: "approval_not_runnable",
                } as const;
              }
              // Current + runnable (pending/approved) but `listForTicket` returned
              // it unobserved (a lean ApprovalService, or an event that raced the
              // approve write): fall back to running it as a singleton.
              bundle = [trigger];
              usedFallback = true;
            }
            const ran: Array<{ readonly tool: string; readonly result: unknown }> =
              [];
            for (const approval of bundle) {
              const outcome = yield* executeOneApproval(approval, event);
              // A WorkflowResult (no `ok`) means this action failed / couldn't
              // run; the ticket is already parked. Stop — don't run later actions.
              if (!("ok" in outcome)) return outcome;
              ran.push({ tool: outcome.tool, result: outcome.result });
            }
            // Per-action approval: NEVER resolve a ticket that still has actions
            // awaiting a decision. The operator may approve some now and decide
            // the rest later; keep the ticket parked until every row is decided.
            const stillPending = usedFallback
              ? []
              : all.filter((a) => a.status === "pending");
            if (stillPending.length > 0) {
              return {
                type: "PausedWaitingForApproval",
                approvalId: stillPending[0]!.id,
              } as const;
            }
            // All actions decided. If one was a supplier escalation, the ticket is
            // now waiting on the SUPPLIER (not done): park `waiting_for_supplier`
            // so the agent re-engages on `supplier.updated`, exactly like the
            // in-loop escalate path. A `no_supplier` escalate (escalated:false)
            // is not a wait — it falls through to resolve.
            const escalatedInBundle = ran.some(
              (r) =>
                r.tool === "supplier.escalate" &&
                (r.result as { readonly escalated?: boolean } | null)
                  ?.escalated === true,
            );
            // Concurrent wait states: the ticket may ALREADY carry an open
            // escalation from a PRIOR tick (queued alongside this approval).
            // Resolving now would close the ticket out from under that supplier
            // wait. Consult the row-derived source of truth; absent/erroring
            // service degrades to `false` (the old bundle-only behavior).
            const hasOpenEscalation = Option.isSome(maybeSupplierEscalation)
              ? yield* maybeSupplierEscalation.value
                  .hasOpenEscalationForTicket(working.tenantId, working.id)
                  .pipe(Effect.catchAll(() => Effect.succeed(false)))
              : false;
            const escalatedToSupplier = escalatedInBundle || hasOpenEscalation;
            if (escalatedToSupplier) {
              working = yield* lifecycle.parkWaitingForSupplier({
                ticketId: working.id,
                tenantId: working.tenantId,
                agentId: trigger.agentId,
                tool: "supplier.escalate",
                callId: `approval-${trigger.id}`,
              });
              return { type: "PausedWaitingForSupplier" } as const;
            }
            // Nothing left to wait on — resolve once.
            working = yield* lifecycle.resolve({
              ticketId: working.id,
              tenantId: working.tenantId,
              actor: { type: "user", id: event.managerId },
              reason:
                bundle.length > 1
                  ? `approved bundle of ${bundle.length} actions`
                  : `approved tool ${bundle[0]!.tool}`,
              details: {
                approvalIds: bundle.map((a) => a.id),
                tools: bundle.map((a) => a.tool),
              },
            });
            return { type: "Completed" } as const;
        });

        const handleApprovalRejected = (
          event: Extract<DomainEvent, { type: "approval.rejected" }>,
        ) =>
          Effect.gen(function* () {
            // H4: reconcile against current state before acting. A rejection is
            // authoritative ONLY for a CURRENT-round approval that hasn't been
            // acted on. A rejection for a prior attempt (a lower epoch) or one
            // already handled is a stale/replayed event — ignore it. Escalating
            // unconditionally was the stale-reject storm: a redelivered/re-
            // published reject from an old round yanked a ticket that had moved on
            // into human_takeover, which then blocked its approved reply from
            // ever sending.
            const rejected = yield* approvals
              .getById(event.approvalId, working.tenantId)
              .pipe(
                Effect.catchTag("ApprovalNotFound", () => Effect.succeed(null)),
                Effect.catchAll(() => Effect.succeed(null)),
              );
            const stale =
              !rejected ||
              (rejected.resumedAt ?? null) !== null ||
              (rejected.epoch ?? 0) !== (working.epoch ?? 0);
            if (stale) {
              yield* tx.run(
                audit.record({
                  tenantId: working.tenantId,
                  ticketId: working.id,
                  actor: { type: "system", id: "runtime" },
                  action: "approval.ignored_stale",
                  details: {
                    approvalId: event.approvalId,
                    event: "approval.rejected",
                    reason: !rejected
                      ? "approval_not_found"
                      : (rejected.resumedAt ?? null) !== null
                        ? "already_resumed"
                        : "stale_epoch",
                    epoch: rejected?.epoch ?? null,
                    ticketEpoch: working.epoch ?? 0,
                  },
                }),
              );
              return { type: "Completed" } as const;
            }
            working = yield* lifecycle.escalateToHuman({
              ticketId: working.id,
              tenantId: working.tenantId,
              actor: { type: "user", id: event.managerId },
              reason: "approval rejected",
              details: {
                approvalId: event.approvalId,
                reason: event.reason ?? null,
              },
            });
            // Retire the decision so a redelivery/sweep can't replay it.
            yield* approvals
              .markResumed(event.approvalId, working.tenantId)
              .pipe(Effect.catchAll(() => Effect.void));
            // Confirmation ping: rejecting the draft makes the ticket theirs.
            yield* notifyMerchant(
              working.tenantId,
              humanTakeoverNotification({
                ticketId: working.id,
                subject: working.subject,
                reason: "approval rejected",
              }),
            );
            return {
              type: "HumanTakeoverRequired",
              reason: "approval rejected",
            } as const;
        });

        const enrichTicket = Effect.gen(function* () {
          // 2a. Customer identification — only on a freshly-created ticket
          // bound to an inbound message. Best-effort: the tick proceeds
          // even if Shopify is down / not configured / has no match for
          // this email. Persists `customerEmail` (always when we have one)
          // and `shopifyCustomerId` (only on a positive match) into the
          // ticket context. Specialists like refund-review can read these
          // without firing their own searchByEmail per tick.
          if (wasCreated && event.type === "message.received") {
            // Prefer Reply-To over From: relay-delivered mail (Shopify
            // contact form) carries the real customer in Reply-To, so the
            // stamped customerEmail must point at the human, not the relay.
            const email = inboundCustomerEmail(event.payload);
            if (email) {
              const contextPatch: Record<string, unknown> = {
                ...working.context,
                customerEmail: email,
              };
              // Capture the sender's display name too, so tickets are searchable
              // by customer name (not just email). Best-effort — many emails
              // carry no name.
              const name = inboundCustomerName(event.payload);
              if (name) contextPatch["customerName"] = name;
              // A structured inbound email (Shopify contact form) carries the
              // shopper's phone as a labelled field — capture it. Deterministic
              // parse, no LLM (see inboundCustomerPhone).
              const phone = inboundCustomerPhone(event.payload);
              if (phone) contextPatch["customerPhone"] = phone;
              // Resolve the Shopify customer by email → phone → name and stamp
              // the canonical `shopifyCustomerId` from the first hit. Order
              // lookup + the order/customer-mismatch guard then match orders to
              // THIS customer, not just the thread email (the "trust any match"
              // decision). Best-effort: each leg fails to null.
              const orNull = (
                eff: Effect.Effect<
                  { readonly id: string } | null,
                  unknown,
                  never
                >,
              ) => eff.pipe(Effect.catchAll(() => Effect.succeed(null)));
              let customer = yield* orNull(
                shopify.searchByEmail(working.tenantId, email),
              );
              if (!customer && phone) {
                customer = yield* orNull(
                  shopify.searchByPhone(working.tenantId, phone),
                );
              }
              if (!customer && name) {
                customer = yield* orNull(
                  shopify.searchByName(working.tenantId, name),
                );
              }
              if (customer) contextPatch["shopifyCustomerId"] = customer.id;
              working = yield* tickets
                .update(working.id, { context: contextPatch as never })
                .pipe(
                  Effect.catchAll(() => Effect.succeed(working)),
                );
            }
          }

          // 2a-bis. Order-status identity verification — when a customer replies
          // to a ticket we flagged as an order/customer mismatch, check (in the
          // runtime, never the model) whether their reply states the email the
          // order was placed under. A match clears the disclosure gate so the
          // status reply can proceed automatically; a miss leaves the ticket gated
          // (the reply still routes to human approval via the backstop at the
          // permission check). Keyed off `pendingOrderEmail`, persisted at
          // detection time. Best-effort: a write failure simply leaves the gate
          // up. The model cannot set `identityVerified`/`verifiedCustomerEmail` —
          // they're stamped here and absent from the ticket.update_context
          // allowlist — so a prompt-injected reply body can't fake a pass. The
          // saved `verifiedCustomerEmail` is the TRUSTED order email, surfaced on
          // the ticket (Context panel + Customer card) once the requester confirms
          // it; see `orderIdentityVerificationPatch`.
          if (
            event.type === "message.received" ||
            event.type === "customer.replied"
          ) {
            const verification = orderIdentityVerificationPatch(
              event.payload.bodyText,
              working.context,
            );
            if (verification) {
              working = yield* tickets
                .update(working.id, {
                  context: {
                    ...working.context,
                    ...verification,
                  } as never,
                })
                .pipe(Effect.catchAll(() => Effect.succeed(working)));
              yield* audit
                .record({
                  tenantId: working.tenantId,
                  ticketId: working.id,
                  actor: { type: "system", id: "runtime" },
                  action: "ticket.identity_verified",
                  details: { method: "order_email_confirmed" },
                })
                .pipe(Effect.catchAll(() => Effect.void));
            }
          }

          // 2b. Photo signals — when an inbound message carries image
          // attachments, stamp a per-ticket EXIF rollup onto the context. A
          // stripped image (no camera metadata) is a cheap fraud signal for
          // the damaged-product flow; the dashboard ApprovalCard surfaces it
          // as a chip. Best-effort — a context-write failure never blocks the
          // tick, and a fresh stamp overwrites any prior one (latest reply
          // wins, mirroring `productMatch`).
          if (
            event.type === "message.received" ||
            event.type === "customer.replied"
          ) {
            const attachments = event.payload.attachments;
            const signals = summarizePhotoSignals(attachments);

            // Duplicate-photo guard: when an ImageHashStore is wired (it's
            // optional — absent in many test layers, present in the worker),
            // compare each photo's perceptual hash against the tenant's
            // recent hashes. A near-match on ANOTHER ticket flags the re-used
            // "broken item" photo scam. Best-effort: store failures degrade
            // to no flag rather than aborting the tick.
            const maybeStore = maybeImageHashStore;
            const dupFlags: string[] = [];
            if (Option.isSome(maybeStore)) {
              const store = maybeStore.value;
              // The ticket's order, if already identified (a re-reply after the
              // agent resolved it). Usually null on a first message — the order
              // is bound later, and the reconcile after `get_order` re-scopes
              // these flags then.
              const knownOrderId =
                typeof working.context["identifiedOrderId"] === "string" &&
                (working.context["identifiedOrderId"] as string).startsWith(
                  "gid://shopify/Order/",
                )
                  ? (working.context["identifiedOrderId"] as string)
                  : null;
              const seenTicketIds = new Set<string>();
              for (const att of attachments) {
                if (
                  !att.contentType.startsWith("image/") ||
                  typeof att.phash !== "string"
                ) {
                  continue;
                }
                let phash: bigint;
                try {
                  phash = BigInt(att.phash);
                } catch {
                  continue;
                }
                const hits = yield* store
                  .findSimilar({
                    tenantId: working.tenantId,
                    ticketId: working.id,
                    phash,
                    orderId: knownOrderId,
                    maxDistance: 5,
                    sinceDays: 90,
                  })
                  .pipe(
                    Effect.catchAll(() =>
                      Effect.succeed(
                        [] as ReadonlyArray<SimilarImageHit>,
                      ),
                    ),
                  );
                for (const hit of hits) {
                  if (!seenTicketIds.has(hit.ticketId)) {
                    seenTicketIds.add(hit.ticketId);
                    dupFlags.push(
                      `${DUPLICATE_PHOTO_FLAG_PREFIX}${hit.ticketId}`,
                    );
                  }
                }
                // Record this photo's hash so future uploads can match it.
                yield* store
                  .record({
                    tenantId: working.tenantId,
                    ticketId: working.id,
                    phash,
                    orderId: knownOrderId,
                  })
                  .pipe(Effect.catchAll(() => Effect.void));
              }
            }

            if (signals || dupFlags.length > 0) {
              const existingFlags = Array.isArray(working.context["riskFlags"])
                ? (working.context["riskFlags"] as unknown[]).filter(
                    (f): f is string => typeof f === "string",
                  )
                : [];
              const mergedFlags = Array.from(
                new Set([...existingFlags, ...dupFlags]),
              );
              const patch: Record<string, unknown> = { ...working.context };
              if (signals) patch["photoSignals"] = signals;
              if (mergedFlags.length > 0) patch["riskFlags"] = mergedFlags;
              working = yield* tickets
                .update(working.id, { context: patch as never })
                .pipe(Effect.catchAll(() => Effect.succeed(working)));
            }
          }
        });

        const checkParkGuards = Effect.gen(function* () {
          // 2.9. Hold events that arrive while an approval is still pending.
          // A ticket parked in `waiting_for_approval` must stay parked until
          // the manager decides (`approval.approved` / `approval.rejected`,
          // short-circuited above) or a human takes over out-of-band (which
          // cancels the approval without running the agent). ANY other event
          // that reaches here — the customer replying again on the same
          // thread, a follow-up timer firing — must NOT re-enter the agent
          // loop: a `final_message` (or a `ticket.update_status`) decision would
          // then resolve the ticket out from under the still-pending approval,
          // so the manager would see "resolved" for a draft they never
          // approved. We re-park instead. (If the status says
          // `waiting_for_approval` but no pending row exists — a stale /
          // inconsistent ticket — we fall through so the agent can still make
          // progress; the pending approval row is the source of truth.)
          if (working.status === "waiting_for_approval") {
            const pendingForTicket = yield* approvals
              .listPending(working.tenantId)
              .pipe(Effect.catchAll(() => Effect.succeed([])));
            const open = pendingForTicket.find((a) => a.ticketId === working.id);
            if (open) {
              yield* tx.run(
                audit.record({
                  tenantId: working.tenantId,
                  ticketId: working.id,
                  actor: { type: "system", id: "runtime" },
                  action: "event.held_pending_approval",
                  details: { eventType: event.type, approvalId: open.id },
                }),
              );
              return {
                type: "PausedWaitingForApproval",
                approvalId: open.id,
              } as const;
            }
          }

          // 2.95. Hold every event once a human has taken the ticket over.
          // `human_takeover` means a person owns this conversation; an inbound
          // customer reply, a follow-up timer, or any other event must NOT
          // re-enter the agent loop and answer over the human (the runtime
          // also has no message-history replay, so it would respond with only
          // the latest message as context — doubly wrong). The ticket stays
          // parked until a manager hands it back from the dashboard, which
          // transitions it out of `human_takeover` so subsequent events flow
          // through normally. We record the held event for the audit trail.
          if (working.status === "human_takeover") {
            yield* tx.run(
              audit.record({
                tenantId: working.tenantId,
                ticketId: working.id,
                actor: { type: "system", id: "runtime" },
                action: "event.held_human_takeover",
                details: { eventType: event.type },
              }),
            );
            return { type: "PausedForHumanTakeover" } as const;
          }

          if (working.status === "archived") {
            const shouldReopen =
              event.type === "message.received" || event.type === "customer.replied";
            if (!shouldReopen) {
              yield* tx.run(
                audit.record({
                  tenantId: working.tenantId,
                  ticketId: working.id,
                  actor: { type: "system", id: "runtime" },
                  action: "event.held_archived",
                  details: { eventType: event.type },
                }),
              );
              return { type: "PausedArchived" } as const;
            }
          }

          // 2.96. Hold events while the ticket is parked on the supplier. A ticket in
          // `waiting_for_supplier` belongs to the warehouse until they respond, so
          // a stray customer reply or follow-up timer must NOT re-enter the agent
          // loop (the agent would answer the customer while the supplier still
          // owns the ticket — mirrors the approval/takeover park guards above). Only
          // `supplier.updated` (the supplier responded — the loop below drafts the
          // customer reply) and the human-control events (`manual.takeover` /
          // `ticket.resumed`) pass through.
          if (working.status === "waiting_for_supplier") {
            const passthrough =
              event.type === "supplier.updated" ||
              event.type === "manual.takeover" ||
              event.type === "ticket.resumed";
            if (!passthrough) {
              yield* tx.run(
                audit.record({
                  tenantId: working.tenantId,
                  ticketId: working.id,
                  actor: { type: "system", id: "runtime" },
                  action: "event.held_waiting_for_supplier",
                  details: { eventType: event.type },
                }),
              );
              return { type: "PausedWaitingForSupplier" } as const;
            }
          }
            return null;
        });

        const maybeReopen = Effect.gen(function* () {
          // 2.97. Reopen a resolved/archived ticket when the customer writes back
          // on the thread. The state machine permits `resolved|archived →
          // in_progress` (a reply re-enters the loop) but nothing performed the
          // transition: the ticket stayed visually `resolved` while the agent
          // re-ran, and a closing
          // `final_message` then short-circuited (status already resolved) so a
          // genuine re-engagement could finish invisibly. Transitioning here
          // surfaces the reopen on the timeline and lets the normal
          // resolve/await paths run against a coherent status. Only inbound
          // customer messages reopen; system events (timers, approvals) never
          // resurrect a resolved ticket.
          if (
            (event.type === "message.received" ||
              event.type === "customer.replied") &&
            (working.status === "resolved" || working.status === "archived")
          ) {
            working = yield* lifecycle.reopenForCustomerReply({
              ticketId: working.id,
              tenantId: working.tenantId,
              eventType: event.type,
            });
          }
        });

        const runAgentLoop = Effect.gen(function* () {
          // 3. Run the workflow loop.
          // Load per-tenant overrides once per tick. A handoff later in the
          // same tick reuses this map — overrides don't change mid-tick.
          const overrideMap = yield* overrides
            .getForTenant(working.tenantId)
            .pipe(
              Effect.catchAll(() =>
                Effect.succeed(
                  new Map() as ReadonlyMap<AgentConfig["id"], AgentOverride>,
                ),
              ),
            );
          // Load tenant settings once per tick — `buildSystemPrompt` reads
          // `supplierEscalationSheet` to optionally append the supplier
          // header to the agent prompt. DB failures fall back to `null`
          // so the runtime continues with the bare agent prompt rather
          // than crashing on a settings-table issue.
          const tenantSettings: TenantSettings | null =
            preloadedSettings ??
            (yield* tenantRepo
              .getSettings(working.tenantId)
              .pipe(Effect.catchAll(() => Effect.succeed(null))));
          // Knowledge-base document summaries for the system-prompt header and
          // `@docs.<id>` references. Loaded once per tick (titles only — the
          // `knowledge.search` tool pulls the bodies on demand). Absent service
          // (test layers) → no docs; DB failures fall back to an empty list so
          // the runtime keeps going with the bare prompt.
          const knowledgeDocs = Option.isSome(
            maybeKnowledge,
          )
            ? yield* maybeKnowledge.value
                .list(working.tenantId)
                .pipe(
                  Effect.catchAll(() =>
                    Effect.succeed([] as ReadonlyArray<never>),
                  ),
                )
            : [];
          // The tenant's active custom agents that opted to be callable from
          // some agent (Phase C inbound routing). Loaded once per tick; used to
          // extend the running agent's effective handoffs + to inject the prompt
          // roster. Never fails (resolver swallows DB errors → []).
          const allSpecialists = yield* resolver.customSpecialists(
            working.tenantId,
          );
          // Resolve the ticket's current agent (built-in or custom). A miss means
          // the agent was deleted/disabled (or the id is otherwise unknown):
          // park the ticket for a human rather than letting an UnknownAgent crash
          // bubble to the outer classifier as a retryable Failed — that would
          // loop forever in pg-boss (audit C1 / L4).
          const resolved = yield* resolver.tryResolve(
            working.tenantId,
            working.currentAgentId,
          );
          if (!resolved) {
            yield* escalateToHuman(working.id, "agent_unresolvable", {
              agentId: working.currentAgentId,
            });
            return {
              type: "HumanTakeoverRequired",
              reason: "agent_unresolvable",
            } as const;
          }
          // Scenario envelope (slice 5): when an autonomous agent runs under a
          // merchant scenario, clamp its tool/permission envelope and inject the
          // playbook header. Triage picks the scenario and stamps it on the ticket
          // as `context.scenarioKey`; the policy comes from tenant settings
          // (defaults-on-read). No flag / no key / no match → the agent runs
          // unclamped. Applied at every point the active agent is (re)bound — the
          // initial resolve here and each handoff site — so a triage→scenario
          // handoff in the same tick is clamped too.
          const resolutionPolicy =
            tenantSettings?.resolutionPolicy ?? defaultResolutionPolicy;
          const withScenario = (
            a: AgentConfig,
            ctx: typeof working.context,
          ): AgentConfig =>
            applySelectedScenarioPolicy(a, resolutionPolicy, ctx);
          // Resolution-agent-direct: inbound tickets bound to the primary
          // (support-triage) run the scenario-resolution-agent DIRECTLY — it
          // picks the matching scenario itself (sets `scenarioKey`) and resolves
          // end-to-end. This replaced the old triage→handoff routing, whose
          // brittle classification step intermittently silently-resolved tickets
          // (a weak triage model bailing to `final_message` instead of handing
          // off).
          //
          // Unconditional since 2026-07-10 — it was behind a per-tenant
          // `resolutionAgentEnabled` flag, now removed. The scenario agent is
          // THE entry point for every tenant. The legacy specialists are still
          // registered and reachable by an explicit `agent.handoff`, but nothing
          // routes to them on its own any more. (`applyTriageScenarioRouting`,
          // the old triage-side variant, is retained + tested but unwired.)
          //
          // The swap is skipped when the resolution agent can't be resolved for
          // this tenant, which leaves the ticket on triage — the one remaining
          // path back to the legacy specialists, and the safe failure mode.
          let entryBase: AgentConfig = applyOverride(resolved, overrideMap);
          if ((resolved.id as string) === "support-triage") {
            const resolutionAgent = yield* resolver.tryResolve(
              working.tenantId,
              makeAgentId(SCENARIO_RESOLUTION_AGENT_ID),
            );
            if (resolutionAgent) {
              entryBase = applyOverride(resolutionAgent, overrideMap);
              // Persist the entry binding so the dashboard shows the agent that
              // is actually handling the ticket and a later resume runs it
              // directly (resolves straight to the resolution agent, no re-swap).
              // One-time write per entry; a restart-from-triage rebinds to
              // support-triage and re-enters here.
              working = yield* tx.run(
                Effect.gen(function* () {
                  const updated = yield* tickets.update(working.id, {
                    currentAgentId: makeAgentId(SCENARIO_RESOLUTION_AGENT_ID),
                  });
                  yield* audit.record({
                    tenantId: updated.tenantId,
                    ticketId: updated.id,
                    actor: { type: "system", id: "runtime" },
                    action: "agent.routed",
                    details: {
                      from: "support-triage",
                      to: SCENARIO_RESOLUTION_AGENT_ID,
                      via: "resolution-agent-direct",
                    },
                  });
                  return updated;
                }),
              );
            }
          }
          // The resolution agent picks the scenario itself — inject the scenario
          // menu whenever it runs as the entry point: the swap just above, OR a
          // resume where current_agent_id is already the resolution agent.
          if ((entryBase.id as string) === SCENARIO_RESOLUTION_AGENT_ID) {
            entryBase = applyResolutionAgentEntry(entryBase, resolutionPolicy);
          }
          // Keep the clean, unsteered binding separate from the active agent.
          // A scenario can change inside the tool loop; rebuilding from this
          // base replaces the old playbook instead of stacking contradictory
          // scenario headers while preserving the accumulated messages.
          let agentBase: AgentConfig = entryBase;
          let agent: AgentConfig = withScenario(agentBase, working.context);
          // Some ticks re-enter the agent loop with no inbound customer message —
          // a resume (dashboard retry / restart-from-triage / hand-back), or a
          // supplier responding on a parked ticket. The agent starts blind, so
          // pre-fetch the full thread and let it re-orient on the ACTUAL
          // conversation and what was already done, instead of being told to
          // fetch it itself (triage has no such tool). See `shouldPrefetchThread`.
          // Best-effort: a connector hiccup or a lean layer without
          // ConversationService falls back to the fetch directive.
          let resumeTranscript: string | null = null;
          if (
            shouldPrefetchThread(event.type) &&
            working.threadId &&
            working.mailbox &&
            Option.isSome(maybeConversation)
          ) {
            resumeTranscript = yield* maybeConversation.value
              .fetchThread(
                working.tenantId,
                working.threadId,
                working.mailbox,
              )
              .pipe(
                Effect.map(renderThreadTranscript),
                Effect.catchAllCause(() => Effect.succeed(null)),
              );
          }
          const messages: ChatMessage[] = buildInitialMessages(event, {
            subject: working.subject,
            threadId: working.threadId,
            context: working.context,
            threadTranscript: resumeTranscript,
          });
          let current = working;
          // Order id/name → customer email, populated as `shopify.get_order`
          // results come back this tick. Used to flag a `refund.create` that
          // targets an order belonging to a different customer than the ticket
          // (prompt-injection scope guard — see refundCustomerMismatchFlag).
          const seenOrderEmails = new Map<string, string | null>();
          // Autonomous loop (slice 4b/4c): in autonomous mode a gated (`ask`)
          // tool is QUEUED here (a pending approval row, no park) and the loop
          // continues; `sentAutoReply` records whether an auto-permitted
          // customer reply actually went out. At end-of-loop these drive the
          // status mapping: queued actions → one waiting_for_approval bundle;
          // else an auto reply sent → resolved; else nothing → human_takeover.
          const queuedApprovals: ApprovalId[] = [];
          let sentAutoReply = false;

          // Map an LLM call failure to a terminal result: BYOK credential gaps
          // and deterministic failures park for a human; anything else is a
          // retryable Failed (pg-boss retries with backoff).
          const handleLlmFailure = (
            err: LLMError,
            current: typeof working,
            turn: number,
          ) =>
            Effect.gen(function* () {
              if (
                err._tag === "LLMCredentialMissing" ||
                err._tag === "LLMCredentialRevoked"
              ) {
                const reason =
                  err._tag === "LLMCredentialMissing"
                    ? "llm_credential_missing"
                    : "llm_credential_revoked";
                current = yield* lifecycle.escalateToHuman({
                  ticketId: current.id,
                  tenantId: current.tenantId,
                  actor: { type: "system", id: "agent-runtime" },
                  reason,
                  details:
                    err._tag === "LLMCredentialRevoked"
                      ? { provider: err.provider }
                      : {},
                });
                yield* notifyMerchant(
                  current.tenantId,
                  humanTakeoverNotification({
                    ticketId: current.id,
                    subject: current.subject,
                    reason,
                  }),
                );
                return {
                  type: "HumanTakeoverRequired",
                  reason,
                } as const;
              }
              // Out of LLM credits (prepaid key at zero → provider 402). Like a
              // credential gap, this is a BILLING problem only the merchant can
              // fix: retrying just replays a request that can't succeed and
              // would dead-letter as opaque `workflow_retries_exhausted`. Park
              // for a human with a precise reason and ping the merchant to top
              // up. (Previously a 402 mapped to NetworkError → retryable.)
              if (err._tag === "InsufficientCredits") {
                current = yield* lifecycle.escalateToHuman({
                  ticketId: current.id,
                  tenantId: current.tenantId,
                  actor: { type: "system", id: "agent-runtime" },
                  reason: "llm_insufficient_credits",
                  details: { provider: err.provider },
                });
                yield* notifyMerchant(
                  current.tenantId,
                  humanTakeoverNotification({
                    ticketId: current.id,
                    subject: current.subject,
                    reason: "llm_insufficient_credits",
                  }),
                );
                return {
                  type: "HumanTakeoverRequired",
                  reason: "llm_insufficient_credits",
                } as const;
              }
              // Deterministic LLM failures: retrying replays the exact same
              // request, so park the ticket for a human instead of burning
              // retries (audit C1).
              if (
                err._tag === "ContextTooLarge" ||
                err._tag === "SafetyBlocked"
              ) {
                const reason =
                  err._tag === "ContextTooLarge"
                    ? "llm_context_too_large"
                    : "llm_safety_blocked";
                yield* escalateToHuman(current.id, reason, { turn });
                return { type: "HumanTakeoverRequired", reason } as const;
              }
              // Transient failures (provider 5xx/429, network, a malformed
              // tool call that a fresh sample may fix): surface as a
              // retryable Failed so the worker rethrows and pg-boss retries
              // with backoff (audit C1 — previously these were swallowed as
              // non-retryable and the event was lost forever).
              return {
                type: "Failed",
                reason: `llm transient error: ${err._tag}`,
                retryable: true,
              } as const;
            });

          // Park the ticket in waiting_for_approval (approval row + transition +
          // audit in one tx) and fan out the signed approval links. Always ends
          // the tick with PausedWaitingForApproval.
          const parkForApproval = (
            tool: AnyTool,
            callInput: unknown,
            agent: AgentConfig,
            current: typeof working,
            turn: number,
            reasoning: string,
          ) =>
            Effect.gen(function* () {
              // Approval row + park transition + audit row in ONE tx (audit
              // L6) — a crash between them previously left a pending approval
              // on an un-parked ticket, so the agent could keep acting and a
              // second approval could be created. master-plan §4: the audit
              // write shares the transaction with the state change.
              const parked = yield* lifecycle.parkForApproval({
                ticketId: current.id,
                tenantId: current.tenantId,
                agentId: agent.id,
                tool: tool.name,
                proposedInput: callInput,
                reasoning,
                riskLevel: riskFor(tool),
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
                turn,
              });
              const approval = parked.approval;
              current = parked.ticket_;

              // Fire the approval-link email + merchant ping. Best-effort: a
              // Resend outage, a tenant without `notificationEmail` configured,
              // or any other mail failure must NOT block the ticket. The approval
              // row is the source of truth and the dashboard picks it up
              // regardless; the maintenance cron re-sends this same
              // notification if the first send was dropped. `buildApprovalNotification`
              // is shared with that reminder path so the signed links + preview
              // can't drift. Each URL carries its OWN token with the action
              // bound into the HMAC (audit S3) — a reject link must not approve.
              const notification = buildApprovalNotification({
                approvalId: approval.id,
                tenantId: current.tenantId,
                ticketId: current.id,
                tool: tool.name,
                proposedInput: callInput,
                linkConfig,
              });
              yield* mail
                .sendApprovalLink(notification.mail)
                .pipe(Effect.either);
              yield* notifyMerchant(current.tenantId, notification.merchant);

              return {
                type: "PausedWaitingForApproval",
                approvalId: approval.id,
              } as const;
            });

          // Autonomous loop end-of-run (slice 4c): the agent stopped with one or
          // more QUEUED gated actions. Park the ticket ONCE in waiting_for_approval
          // (a single transition covering the whole bundle) and send ONE merchant
          // ping. The dashboard (slice 7) is the bundle approve/reject surface;
          // on approval the runtime executes the queued rows in order (slice 4d).
          const parkQueuedBundle = (current: typeof working, agent: AgentConfig, turn: number) =>
            Effect.gen(function* () {
              const parked = yield* lifecycle.parkForApprovalBundle({
                ticketId: current.id,
                tenantId: current.tenantId,
                agentId: agent.id,
                approvalIds: queuedApprovals,
                turn,
              });
              // Ping the merchant ONCE with what was actually queued. The
              // rows are re-read (id-filtered, so a stale pending row from
              // an earlier park isn't attributed to this bundle) and each
              // action is summarized from its structured proposedInput —
              // deterministic code, no LLM at send time. The single link is
              // a signed, ticket-bound magic link to the api's bundle
              // review page (GET renders, POST decides); there are no bare
              // approve/reject links because a bundle must never be decided
              // sight-unseen. Best-effort: a failed read still pings.
              const queuedIds = new Set<string>(queuedApprovals);
              const queuedRows = (yield* approvals
                .listForTicket(parked.tenantId, parked.id)
                .pipe(
                  Effect.catchAll(() =>
                    Effect.succeed([] as ReadonlyArray<Approval>),
                  ),
                )).filter((a) => queuedIds.has(a.id));
              const ctxEmail = parked.context["customerEmail"];
              const bundleNotification = buildBundleApprovalNotification({
                tenantId: parked.tenantId,
                ticketId: parked.id,
                ticketSubject: parked.subject,
                customerEmail:
                  typeof ctxEmail === "string" && ctxEmail.length > 0
                    ? ctxEmail
                    : null,
                actions: queuedRows.map((a) => ({
                  tool: a.tool,
                  proposedInput: a.proposedInput,
                })),
                linkConfig,
              });
              yield* notifyMerchant(
                parked.tenantId,
                bundleNotification.merchant,
              );
              return {
                type: "PausedWaitingForApproval",
                approvalId: queuedApprovals[0]!,
              } as const;
            });

          // Run one tool_call decision: push the assistant message, intercept
          // agent.handoff, validate + dedup + permission-gate, then execute (or
          // park). Returns the (possibly handed-off) agent, the refreshed ticket,
          // and `done`: a terminal WorkflowResult to end the tick, or null to
          // continue the loop. messages/seenOrderEmails are mutated in place.
          const executeToolCall = (
            decision: Extract<LLMDecision, { type: "tool_call" }>,
            agent: AgentConfig,
            current: typeof working,
            turn: number,
          ) =>
            Effect.gen(function* () {
              // tool_call

              // Record the LLM's tool call in the conversation BEFORE invoking
              // the tool. The Anthropic/Gemini APIs (and the AI SDK in front of
              // them) expect every `tool` role message to be paired with a
              // preceding `assistant` message that carries the matching
              // `toolCallId`. Without this push, subsequent turns see only
              // user + orphan tool results — providers drop the tool messages
              // and the model behaves as if no prior tool call ever happened,
              // looping on the same tool every turn until `max_turns_exceeded`.
              messages.push({
                role: "assistant",
                content: "",
                toolCalls: [
                  {
                    id: decision.callId,
                    name: decision.tool,
                    input: decision.input,
                  },
                ],
              });

              // `agent.handoff` is a runtime-controlled pseudo-tool: it appears
              // in the LLM tool list (so the model can invoke it) but the runtime
              // intercepts the call here rather than running the tool body.
              // We swap the active agent for the rest of the tick, persist the
              // new `currentAgentId`, audit the handoff as a `tool.invoked`, and
              // push a tool-result back into the conversation so the new agent
              // sees the prior agent's work plus a record of the transition.
              if (decision.tool === "agent.handoff") {
                const raw = decision.input as {
                  readonly targetAgent?: unknown;
                  readonly reason?: unknown;
                } | null;
                const target =
                  raw && typeof raw.targetAgent === "string"
                    ? raw.targetAgent
                    : null;
                const reason =
                  raw && typeof raw.reason === "string" ? raw.reason : "";
                // Effective handoffs = the agent's static targets ∪ custom
                // specialists that opted to be callable from it (Phase C).
                const effective = effectiveHandoffIds(agent, allSpecialists);
                const allowed = target !== null && effective.has(target);

                if (!allowed) {
                  yield* tx.run(
                    audit.record({
                      tenantId: current.tenantId,
                      ticketId: current.id,
                      actor: { type: "agent", id: agent.id },
                      action: "tool.invoked",
                      details: {
                        tool: "agent.handoff",
                        callId: decision.callId,
                        ok: false,
                        error: "target_not_in_handoffs",
                        target,
                        turn,
                      },
                    }),
                  );
                  messages.push({
                    role: "tool",
                    toolCallId: decision.callId,
                    toolName: "agent.handoff",
                    content: {
                      error: "target_not_in_handoffs",
                      target,
                      allowed: [...effective],
                    },
                  });
                  return { agent, current, done: null };
                }

                const targetAgentId = makeAgentId(target as string);
                const resolvedTarget = yield* resolver.tryResolve(
                  current.tenantId,
                  targetAgentId,
                );
                if (!resolvedTarget) {
                  // The target passed the handoffs allowlist but no longer
                  // resolves (a custom agent deleted between check and resolve,
                  // or a built-in id typo). Keep the tick alive — surface the
                  // error so the current agent can recover — rather than crash.
                  yield* tx.run(
                    audit.record({
                      tenantId: current.tenantId,
                      ticketId: current.id,
                      actor: { type: "agent", id: agent.id },
                      action: "tool.invoked",
                      details: {
                        tool: "agent.handoff",
                        callId: decision.callId,
                        ok: false,
                        error: "handoff_target_unresolvable",
                        target,
                        turn,
                      },
                    }),
                  );
                  messages.push({
                    role: "tool",
                    toolCallId: decision.callId,
                    toolName: "agent.handoff",
                    content: {
                      error: "handoff_target_unresolvable",
                      target,
                    },
                  });
                  return { agent, current, done: null };
                }
                agentBase = applyOverride(resolvedTarget, overrideMap);
                const targetAgent = withScenario(agentBase, current.context);
                current = yield* tx.run(
                  Effect.gen(function* () {
                    const updated = yield* tickets.update(current.id, {
                      currentAgentId: targetAgentId,
                    });
                    yield* audit.record({
                      tenantId: updated.tenantId,
                      ticketId: updated.id,
                      actor: { type: "agent", id: agent.id },
                      action: "tool.invoked",
                      details: {
                        tool: "agent.handoff",
                        callId: decision.callId,
                        ok: true,
                        target: target as string,
                        reason,
                        turn,
                      },
                    });
                    return updated;
                  }),
                );
                messages.push({
                  role: "tool",
                  toolCallId: decision.callId,
                  toolName: "agent.handoff",
                  content: { ok: true, targetAgent: target as string },
                });
                agent = targetAgent;
                return { agent, current, done: null };
              }

              const tool = yield* tools.tryGet(decision.tool);
              if (!tool) {
                messages.push({
                  role: "tool",
                  toolCallId: decision.callId,
                  toolName: decision.tool,
                  content: { error: "unknown_tool" },
                });
                return { agent, current, done: null };
              }

              // Validate the LLM's JSON against the tool's input schema before
              // any permission check or execution (audit L10). On mismatch the
              // model gets a structured `invalid_input` result and self-corrects
              // next turn instead of the malformed payload failing deep inside
              // connector code (or partially succeeding).
              const decodedCall = Schema.decodeUnknownEither(
                tool.inputSchema as Schema.Schema<unknown>,
              )(decision.input);
              if (Either.isLeft(decodedCall)) {
                messages.push({
                  role: "tool",
                  toolCallId: decision.callId,
                  toolName: tool.name,
                  content: {
                    error: "invalid_input",
                    issue: String(decodedCall.left.message).slice(0, 500),
                  },
                });
                return { agent, current, done: null };
              }
              const callInput = decodedCall.right;

              if (isScenarioControlledTool(tool.name)) {
                // The scenario may have changed after this model request was
                // built (same-run update or a concurrent write). Re-read both
                // sources of truth and rebuild from the clean agent binding so
                // a stale schema can never authorize a stale tool call.
                current = yield* tickets
                  .getById(current.id)
                  .pipe(Effect.catchAll(() => Effect.succeed(current)));
                const currentResolutionPolicy =
                  (
                    yield* tenantRepo
                      .getSettings(current.tenantId)
                      .pipe(Effect.catchAll(() => Effect.succeed(null)))
                  )?.resolutionPolicy ?? resolutionPolicy;
                agent = applySelectedScenarioPolicy(
                  agentBase,
                  currentResolutionPolicy,
                  current.context,
                );
                if (
                  tool.name === "supplier.escalate" &&
                  supplierDisabledForSelectedScenario(
                    currentResolutionPolicy,
                    current.context,
                  )
                ) {
                  messages.push({
                    role: "tool",
                    toolCallId: decision.callId,
                    toolName: tool.name,
                    content: { error: "scenario_supplier_disabled" },
                  });
                  return { agent, current, done: null };
                }
              }

              // C2 (in-loop): a redelivered job replays the whole tick from
              // turn 0 — side-effecting tools whose semantic action already
              // executed (matched via their input-derived idempotency key)
              // are skipped with a structured dedup result. Checked before
              // the permission gate: an already-done action must not re-ask.
              const loopExecutionKey = executionKeyFor(
                tool,
                callInput,
                decision.callId,
                deliveryScopeFor(event),
              );
              if (
                tool.sideEffectClass !== "none" &&
                Option.isSome(maybeExecutions)
              ) {
                const marker = yield* maybeExecutions.value
                  .find(current.id, loopExecutionKey)
                  .pipe(Effect.catchAll(() => Effect.succeed(null)));
                if (marker) {
                  messages.push({
                    role: "tool",
                    toolCallId: decision.callId,
                    toolName: tool.name,
                    content: {
                      deduped: true,
                      priorResultOk: marker.resultOk,
                    },
                  });
                  return { agent, current, done: null };
                }
              }

              // Refund scope guard (prompt-injection mitigation): before gating a
              // refund, check whether it targets an order whose customer differs
              // from the ticket's bound customer and, if so, stamp a risk flag onto
              // the ticket context. The approval card surfaces riskFlags as chips,
              // so the human approver is warned the refund may be aimed at an
              // unrelated order. Best-effort and additive — a write failure or a
              // fail-open (unknown) result never blocks the refund.
              if (tool.name === "refund.create") {
                const mismatchFlag = refundCustomerMismatchFlag(
                  callInput,
                  current.context,
                  seenOrderEmails,
                );
                if (mismatchFlag) {
                  current = yield* addRiskFlag(current, mismatchFlag);
                }
              }

              const permission = yield* perms.check({
                tenantId: current.tenantId,
                agent,
                tool,
                payload: callInput,
                ticketId: current.id,
              });

              // Order-status disclosure backstop: a `where_is_order` reply on an
              // unverified order/customer mismatch is forced to human approval even
              // when the tenant set `conversation.reply` to auto. The gate lives in
              // the runtime (not the per-agent policy) so it survives the auto/ask
              // toggle; it only ever escalates allow→ask, never relaxes a deny.
              const effectivePermission =
                permission === "allow" &&
                shouldForceReplyApproval(tool.name, current.context)
                  ? "ask"
                  : permission;

              if (effectivePermission === "deny") {
                messages.push({
                  role: "tool",
                  toolCallId: decision.callId,
                  toolName: tool.name,
                  content: { error: "denied_by_policy" },
                });
                return { agent, current, done: null };
              }

              if (effectivePermission === "ask") {
                // Autonomous loop (slice 4b): a gated action is NON-BLOCKING.
                // Queue it (pending approval row, NO park) and feed back a
                // "queued, not executed" observation so the agent keeps looping
                // and drafts its reply conditionally. The ticket parks once, as a
                // bundle, when the loop ends (parkQueuedBundle).
                if (agent.autonomousLoop) {
                  const approval = yield* lifecycle.queueApproval({
                    ticketId: current.id,
                    tenantId: current.tenantId,
                    agentId: agent.id,
                    tool: tool.name,
                    proposedInput: callInput,
                    reasoning: decision.reasoning ?? "",
                    riskLevel: riskFor(tool),
                    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
                    turn,
                  });
                  queuedApprovals.push(approval.id);
                  messages.push({
                    role: "tool",
                    toolCallId: decision.callId,
                    toolName: tool.name,
                    content: {
                      queued: true,
                      executed: false,
                      note: "Recorded for the merchant to approve; it has NOT run yet. Continue, and write the customer reply conditionally.",
                    },
                  });
                  return { agent, current, done: null };
                }
                return {
                  agent,
                  current,
                  done: yield* parkForApproval(
                    tool,
                    callInput,
                    agent,
                    current,
                    turn,
                    decision.reasoning ?? "",
                  ),
                };
              }

              // allow → execute. The tool's external side effect runs OUTSIDE
              // the SQL transaction (audit D6): holding a pool connection across
              // provider HTTP latency starved the pool, and a commit failure
              // AFTER an email was actually sent rolled back the audit record of
              // a send that really happened. The audit row + execution marker
              // then commit together in one tx (master-plan §4: the audit write
              // shares the transaction with the state change — the external
              // effect itself was never transactional). Tools that mutate ticket
              // state route those writes through their own lifecycle services.
              const ctx: ToolContext = {
                tenantId: current.tenantId,
                ticketId: current.id,
                ...(current.mailbox ? { mailbox: current.mailbox } : {}),
                agentId: agent.id,
                callId: decision.callId,
                attemptNumber: 1,
              };
              // Tool<unknown, unknown> declares R=unknown (master-plan §17). The
              // concrete dependencies a tool actually needs are satisfied by the
              // runtime's outer Layer, so we narrow R to never at the call site.
              const rawToolEffect = tool.execute(
                callInput,
                ctx,
              ) as unknown as Effect.Effect<unknown, unknown, never>;
              // Honor the tool's declared timeout, or a default wall-clock
              // bound when it declares none (audit L15) — a hung connector call
              // must not pin the tick (and previously its DB tx) until the HTTP
              // client's own timeout while the job clock runs toward redelivery.
              const toolEffect = rawToolEffect.pipe(
                Effect.timeout(tool.timeout ?? defaultToolTimeoutMs),
              );
              const result = yield* toolEffect.pipe(Effect.either);
              const toolTx = yield* tx.run(
                Effect.gen(function* () {
                  const outputDetails =
                    tool.name === "refund.recommend" && result._tag === "Right"
                      ? { output: result.right }
                      : // Capture the heads-up content (and whether it reached
                        // the merchant) so the dashboard timeline can show WHAT
                        // the agent flagged, not just that merchant.notify ran.
                        tool.name === "merchant.notify" && result._tag === "Right"
                        ? {
                            notify: {
                              ...(typeof (callInput as { title?: unknown }).title ===
                              "string"
                                ? { title: (callInput as { title: string }).title }
                                : {}),
                              ...(typeof (callInput as { message?: unknown })
                                .message === "string"
                                ? {
                                    message: (callInput as { message: string })
                                      .message,
                                  }
                                : {}),
                              delivered:
                                (result.right as { delivered?: unknown })
                                  .delivered === true,
                            },
                          }
                        : {};
                  yield* audit.record({
                    tenantId: current.tenantId,
                    ticketId: current.id,
                    actor: { type: "agent", id: agent.id },
                    action: "tool.invoked",
                    details: {
                      tool: tool.name,
                      callId: decision.callId,
                      ok: result._tag === "Right",
                      ...refundAuditDetails(tool.name, callInput),
                      ...outputDetails,
                      ...(result._tag === "Left"
                        ? toolFailureAuditDetail(result.left)
                        : {}),
                    },
                  });
                  // C2 marker — same tx as the audit row; only meaningful
                  // for tools with externally-visible effects.
                  const deferFailedReplyMarker =
                    result._tag === "Left" &&
                    isReplyDeliverySendFailure(tool.name, result.left);
                  if (
                    tool.sideEffectClass !== "none" &&
                    Option.isSome(maybeExecutions) &&
                    !deferFailedReplyMarker
                  ) {
                    yield* maybeExecutions.value
                      .record({
                        tenantId: current.tenantId,
                        ticketId: current.id,
                        callId: loopExecutionKey,
                        tool: tool.name,
                        resultOk: result._tag === "Right",
                      })
                      .pipe(Effect.catchAll(() => Effect.void));
                  }
                  const updatedTicket = yield* stampTrackingLookup(
                    current,
                    tool.name,
                    result,
                  );
                  return { result, updatedTicket };
                }),
              );
              const exec = toolTx.result;
              if (toolTx.updatedTicket) current = toolTx.updatedTicket;

              if (exec._tag === "Right") {
                // Index our outbound reply's Message-ID for thread correlation of
                // the customer's eventual reply (best-effort, no-op for non-reply
                // tools).
                yield* recordOutboundReplyId(current, tool.name, exec.right);
                // Autonomous loop: an auto-permitted reply that actually went out
                // (or was deduped from a prior delivery) is the "resolved" signal
                // at end-of-loop. `ask`-gated replies are queued above and never
                // reach here, so this only flips on a genuine auto-send.
                if (tool.name === "conversation.reply") {
                  sentAutoReply = true;
                }
                if (tool.name === "conversation.ask_customer") {
                  current = yield* lifecycle.parkWaitingForCustomer({
                    ticketId: current.id,
                    tenantId: current.tenantId,
                    agentId: agent.id,
                    tool: tool.name,
                    callId: decision.callId,
                  });
                  return { agent, current, done: { type: "PausedWaitingForCustomer" } as const };
                }
                if (
                  tool.name === "supplier.escalate" &&
                  (exec.right as { readonly escalated?: boolean }).escalated === true
                ) {
                  // Producer for `waiting_for_supplier` (mirror of ask_customer) —
                  // ONLY when a supplier was actually found (`escalated: true`). A
                  // `no_supplier` result falls through to the generic tool-result
                  // push below so the agent reads it and falls back to a direct
                  // reply (it must NOT park a ticket nobody is working). The escalation
                  // row was written by the tool's service; here we park the ticket +
                  // audit in one tx, then end the tick. The ticket re-engages on
                  // `supplier.updated` (the consumer). Runs only when escalate
                  // resolved to `allow` (per-agent) — under the default `ask`, the
                  // permission gate above parks in waiting_for_approval instead.
                  //
                  // Concurrent waits: if this tick already QUEUED ask-gated
                  // actions, BOTH waits hold and `primaryWaitStatus` picks the
                  // park — approval wins, so the queued bundle parks (one
                  // merchant ping, guard 2.9 armed) instead of stranding the
                  // pending rows on a waiting_for_supplier ticket. The open
                  // escalation row still carries the supplier wait, and the
                  // notify outbox emails the supplier regardless of status.
                  // (Escalate-first ticks have an empty queue — any reply the
                  // agent still owes is drafted when the supplier answers.)
                  const wait = primaryWaitStatus({
                    approvalPending:
                      agent.autonomousLoop === true && queuedApprovals.length > 0,
                    supplierOpen: true,
                  });
                  if (wait === "waiting_for_approval") {
                    const done = yield* parkQueuedBundle(current, agent, turn);
                    return { agent, current, done };
                  }
                  current = yield* lifecycle.parkWaitingForSupplier({
                    ticketId: current.id,
                    tenantId: current.tenantId,
                    agentId: agent.id,
                    tool: tool.name,
                    callId: decision.callId,
                  });
                  return { agent, current, done: { type: "PausedWaitingForSupplier" } as const };
                }
                messages.push({
                  role: "tool",
                  toolCallId: decision.callId,
                  toolName: tool.name,
                  content: exec.right,
                });
                // Capture the order→customer-email mapping from any get_order
                // result so a later refund.create can be checked against the
                // ticket's bound customer (refund scope guard).
                if (
                  tool.name === "shopify.get_order" &&
                  exec.right &&
                  typeof exec.right === "object"
                ) {
                  const o = exec.right as Record<string, unknown>;
                  const email =
                    typeof o["email"] === "string" ? (o["email"] as string) : null;
                  if (typeof o["id"] === "string") {
                    seenOrderEmails.set(o["id"] as string, email);
                  }
                  if (typeof o["name"] === "string") {
                    seenOrderEmails.set(o["name"] as string, email);
                  }
                  // Order-status identity guard (where_is_order flow only): if the
                  // looked-up order belongs to a different customer than the one
                  // writing in, stamp a risk flag so the reply is gated + the
                  // dashboard warns, and persist the order's email so the customer's
                  // later confirmation reply can be verified by the runtime (not the
                  // model). Additive + best-effort — a write failure never blocks
                  // the tick, and a fail-open (null) result leaves the ticket alone.
                  if (current.context["classification"] === "where_is_order") {
                    const orderCustomerId =
                      typeof o["customerId"] === "string"
                        ? (o["customerId"] as string)
                        : null;
                    const mismatchFlag = orderCustomerMismatchFlag(
                      email,
                      orderCustomerId,
                      current.context,
                    );
                    if (mismatchFlag) {
                      const existingFlags = readRiskFlags(current.context);
                      const patch: Record<string, unknown> = {
                        ...current.context,
                        pendingOrderEmail: normalizeEmailForMatch(email),
                      };
                      if (!existingFlags.includes(mismatchFlag)) {
                        patch["riskFlags"] = [...existingFlags, mismatchFlag];
                      }
                      current = yield* tickets
                        .update(current.id, { context: patch as never })
                        .pipe(Effect.catchAll(() => Effect.succeed(current)));
                    }
                  }
                }
                // Bind the resolved order's canonical GID to the ticket context as
                // the single source of truth: the operator's view (order panel +
                // Issue-refund button) and the agent's `boundOrderDirective`
                // re-resolve it EXACTLY via getOrder(gid) — never a fuzzy
                // name/confirmation search that can diverge. Both order tools
                // surface a concrete order: get_order returns it directly;
                // find_customer_order returns it under `order` when the sender's
                // email matches exactly one (`status: "single"`). We stamp
                // whenever `identifiedOrderId` is NOT already a canonical GID —
                // i.e. a concretely-resolved order PROMOTES an empty field or a
                // legacy fuzzy value (a customer-quoted name/confirmation code
                // that lived here before this became GID-only). A GID already
                // bound is never rebound (first concrete order wins, preserving
                // the identity-gate intent). find_customer_order is keyed on the
                // customer's own sender email, so its order already belongs to
                // them. Best-effort: a write failure leaves the ticket alone.
                const resolvedOrder =
                  tool.name === "shopify.get_order" &&
                  exec.right &&
                  typeof exec.right === "object"
                    ? (exec.right as Record<string, unknown>)
                    : tool.name === "shopify.find_customer_order" &&
                        exec.right &&
                        typeof exec.right === "object" &&
                        (exec.right as Record<string, unknown>)["status"] ===
                          "single" &&
                        (exec.right as Record<string, unknown>)["order"] &&
                        typeof (exec.right as Record<string, unknown>)[
                          "order"
                        ] === "object"
                      ? ((exec.right as Record<string, unknown>)[
                          "order"
                        ] as Record<string, unknown>)
                      : null;
                const existingOrderRef = current.context["identifiedOrderId"];
                const existingIsGid =
                  typeof existingOrderRef === "string" &&
                  existingOrderRef.startsWith("gid://shopify/Order/");
                if (resolvedOrder) {
                  const patch: Record<string, unknown> = {};
                  const newOrderRef = !existingIsGid
                    ? orderContextRef(resolvedOrder)
                    : null;
                  if (newOrderRef) patch["identifiedOrderId"] = newOrderRef;
                  // Persist the order's shipping country so a later
                  // tracking.lookup can be checked against it (the
                  // tracking-destination guard in `stampTrackingLookup`). The
                  // order is the ticket's single order, so this is refreshed
                  // from whichever concrete order resolved.
                  const ship = resolvedOrder["shippingAddress"];
                  const shipCountry =
                    ship && typeof ship === "object"
                      ? (ship as Record<string, unknown>)["country"]
                      : null;
                  if (typeof shipCountry === "string" && shipCountry.trim() !== "") {
                    patch["orderShipCountry"] = shipCountry;
                  }
                  // The order's fulfillments are the canonical tracking
                  // record. A liveTrackingStatus snapshot naming a number the
                  // order no longer tracks under (reship, re-label, or a
                  // Shopify-admin edit — no webhook exists) is superseded:
                  // drop it so the facts header stops describing the old
                  // shipment; the next tracking.lookup re-stamps.
                  const dropSnapshot = trackingSnapshotSupersededByOrder(
                    current.context,
                    resolvedOrder,
                  );
                  if (Object.keys(patch).length > 0 || dropSnapshot) {
                    const { liveTrackingStatus: _superseded, ...healed } =
                      current.context;
                    current = yield* tickets
                      .update(current.id, {
                        context: {
                          ...(dropSnapshot ? healed : current.context),
                          ...patch,
                        } as never,
                      })
                      .pipe(Effect.catchAll(() => Effect.succeed(current)));
                  }
                  // Order-scoped reconcile of the duplicate-photo guard: now
                  // that this ticket's order is known, bind it onto the ticket's
                  // recorded photo hashes and recompute the duplicate flags.
                  // A photo re-used on the SAME order stops flagging (a
                  // legitimate follow-up on one damaged order); a photo re-used
                  // across a DIFFERENT order still flags. Best-effort — a store
                  // failure leaves the ingestion-time flags untouched.
                  if (newOrderRef && Option.isSome(maybeImageHashStore)) {
                    const store = maybeImageHashStore.value;
                    current = yield* Effect.gen(function* () {
                      yield* store.bindOrder({
                        tenantId: current.tenantId,
                        ticketId: current.id,
                        orderId: newOrderRef,
                      });
                      const phashes = yield* store.listPhashesForTicket({
                        tenantId: current.tenantId,
                        ticketId: current.id,
                      });
                      if (phashes.length === 0) return current;
                      const otherTicketIds = new Set<string>();
                      for (const ph of phashes) {
                        const hits = yield* store.findSimilar({
                          tenantId: current.tenantId,
                          ticketId: current.id,
                          phash: ph,
                          orderId: newOrderRef,
                          maxDistance: 5,
                          sinceDays: 90,
                        });
                        for (const hit of hits)
                          otherTicketIds.add(hit.ticketId as string);
                      }
                      const existing = Array.isArray(
                        current.context["riskFlags"],
                      )
                        ? (current.context["riskFlags"] as unknown[]).filter(
                            (f): f is string => typeof f === "string",
                          )
                        : [];
                      const kept = existing.filter(
                        (f) => !f.startsWith(DUPLICATE_PHOTO_FLAG_PREFIX),
                      );
                      const merged = Array.from(
                        new Set([
                          ...kept,
                          ...[...otherTicketIds].map(
                            (id) => `${DUPLICATE_PHOTO_FLAG_PREFIX}${id}`,
                          ),
                        ]),
                      );
                      const unchanged =
                        merged.length === existing.length &&
                        merged.every((f) => existing.includes(f));
                      if (unchanged) return current;
                      return yield* tickets
                        .update(current.id, {
                          context: {
                            ...current.context,
                            riskFlags: merged,
                          } as never,
                        })
                        .pipe(Effect.catchAll(() => Effect.succeed(current)));
                    }).pipe(Effect.catchAll(() => Effect.succeed(current)));
                  }
                }
                // The tool may have mutated the ticket (e.g. transitioned status).
                current = yield* tickets.getById(current.id, current.tenantId);
              } else {
                const errTag =
                  (exec.left as { readonly _tag?: string })._tag ?? "ToolFailure";
                messages.push({
                  role: "tool",
                  toolCallId: decision.callId,
                  toolName: tool.name,
                  content: { error: errTag },
                });
                // A customer-reply SEND failure must NOT be swallowed: feeding the
                // error back to the LLM lets it emit `final_message` and resolve a
                // ticket whose reply never reached the customer (the silent-delivery
                // bug). Capture the draft for retry, flag + park the ticket, and end
                // the tick — a later successful retry auto-resolves it.
                if (isReplyDeliverySendFailure(tool.name, exec.left)) {
                  yield* parkForReplyDeliveryFailure(
                    current,
                    agent.id,
                    tool.name,
                    callInput,
                    exec.left,
                    loopExecutionKey,
                  );
                  return {
                    agent,
                    current,
                    done: {
                      type: "HumanTakeoverRequired",
                      reason: REPLY_DELIVERY_FAILED_FLAG,
                    } as const,
                  };
                }
              }
              return { agent, current, done: null };
            });

          // NOTE: a new customer-email draft superseding an older still-pending
          // draft is enforced generally at approval-creation time (TicketLifecycle
          // Writer.parkForApproval / queueApproval call supersedeOlderDraft), so
          // it holds for every agent + path — not just this loop.

          for (let turn = 0; turn < agent.maxTurnsPerTick; turn++) {
            // Rebind steering at the model boundary so every turn reflects the
            // authoritative scenario selected by the preceding tool call.
            agent = withScenario(agentBase, current.context);
            const schemas = yield* tools.schemasFor(agent.tools);
            // BYOK: surface missing/revoked per-tenant LLM credentials as
            // human_takeover instead of a generic Failed. Other LLM errors
            // continue to bubble up to the outer catchAllCause.
            const decisionEither = yield* llm
              .runToolCalling({
                tenantId: current.tenantId,
                model: agent.model,
                system: buildSystemPrompt(
                  agent,
                  tenantSettings,
                  knowledgeDocs,
                  specialistsCallableFrom(allSpecialists, agent.id as string),
                ),
                messages,
                tools: schemas,
                ...(agent.temperature !== undefined
                  ? { temperature: agent.temperature }
                  : {}),
              })
              .pipe(Effect.either);
            if (decisionEither._tag === "Left") {
              return yield* handleLlmFailure(decisionEither.left, current, turn);
            }
            const decision: LLMDecision = decisionEither.right;

            // Stamp the LLM token usage (when the provider reported it)
            // into the audit row. The dashboard ticket detail rolls these
            // up across `llm.decision` rows to surface per-ticket totals;
            // a future Phase 6 cost dashboard turns tokens into USD.
            // Test layers (Scripted, FromFn) leave `usage` undefined →
            // we just don't include the field; existing tests that assert
            // exact details shapes still pass.
                const usageDetails = decision.usage
                  ? {
                      model: decision.usage.model,
                      ...(decision.usage.provider
                        ? { provider: decision.usage.provider }
                        : {}),
                      inputTokens: decision.usage.inputTokens,
                      outputTokens: decision.usage.outputTokens,
                    }
              : null;
            yield* audit.record({
              tenantId: current.tenantId,
              ticketId: current.id,
              actor: { type: "agent", id: agent.id },
              action: "llm.decision",
              details: {
                turn,
                decisionType: decision.type,
                ...(usageDetails ? { usage: usageDetails } : {}),
              },
            });

            if (decision.type === "final_message") {
              if (current.status !== "resolved" && current.status !== "archived") {
                // Autonomous loop (slice 4c): the agent stopped with queued gated
                // actions. Park the whole bundle for one merchant approval rather
                // than resolving. Checked FIRST so a run that proposed remedies +
                // a reply parks for sign-off instead of falling through to the
                // resolve/no-action branches below. On approval the runtime
                // executes the bundle in order (slice 4d).
                if (agent.autonomousLoop && queuedApprovals.length > 0) {
                  return yield* parkQueuedBundle(current, agent, turn);
                }
                // GUARD: a routing agent (one with handoff targets, e.g.
                // triage) must never resolve a ticket with a bare final
                // message. Its only legitimate terminal move is
                // `agent.handoff` — after a successful handoff `agent` is the
                // specialist (handoffs: []), so this check no longer trips.
                // A still-routing agent that reaches final_message has failed
                // to route; silently resolving here would close the ticket with
                // nothing done (a triage classify → no order id → "done"
                // message used to leave customers with no reply). Park for a
                // human instead of swallowing the ticket. Keyed on `handoffs`,
                // not `mode`: a terminal `mode: "primary"` agent with no
                // handoffs is a legitimate resolver, not a router.
                if (agent.handoffs.length > 0) {
                  yield* escalateToHuman(
                    current.id,
                    "router_final_message_no_handoff",
                    { turn, finalMessage: decision.text },
                  );
                  return {
                    type: "HumanTakeoverRequired",
                    reason: "routing agent finished without handing off",
                  } as const;
                }
                // GUARD: an UNVERIFIED order/customer identity mismatch means we
                // never cleared the disclosure gate — we couldn't confirm we're
                // talking to the right person. Auto-resolving on a bare
                // final_message here closes a live ticket with nothing safely sent
                // (prod 3428f154: order-status-agent drafted a prose answer
                // instead of conversation.reply / ask_customer and the ticket
                // silently resolved). Park for a human, who can verify identity
                // and reply, instead of swallowing the ticket.
                if (hasUnverifiedOrderMismatch(current.context)) {
                  yield* escalateToHuman(
                    current.id,
                    "unverified_identity_mismatch_final_message",
                    { turn, finalMessage: decision.text },
                  );
                  return {
                    type: "HumanTakeoverRequired",
                    reason: "unverified order/customer identity mismatch",
                  } as const;
                }
                // GUARD: the runtime flagged that the looked-up tracking's
                // destination country disagreed with the order's shipping
                // country — the tracking probably belongs to a different order.
                // Auto-resolving on a bare final_message would close the ticket
                // having (at best) told the customer a status that isn't theirs.
                // Park for a human to re-check the tracking number, mirroring the
                // identity-mismatch backstop above.
                if (hasTrackingDestinationMismatch(current.context)) {
                  yield* escalateToHuman(
                    current.id,
                    "tracking_destination_mismatch_final_message",
                    { turn, finalMessage: decision.text },
                  );
                  return {
                    type: "HumanTakeoverRequired",
                    reason: "tracking destination does not match the order",
                  } as const;
                }
                // Autonomous loop (slice 4c): nothing was queued AND no auto
                // reply went out — the run produced no customer-facing action.
                // Never silently resolve (no-silent-resolve invariant); park for
                // a human to pick up.
                if (agent.autonomousLoop && !sentAutoReply) {
                  yield* escalateToHuman(current.id, "autonomous_no_action", {
                    turn,
                    finalMessage: decision.text,
                  });
                  return {
                    type: "HumanTakeoverRequired",
                    reason: "autonomous run produced no actionable result",
                  } as const;
                }
                // The lifecycle writer wraps the final transition +
                // "ticket.resolved" audit in one tx (master-plan §4).
                const resolveExit = yield* lifecycle
                  .resolve({
                    ticketId: current.id,
                    tenantId: current.tenantId,
                    actor: { type: "agent", id: agent.id },
                    reason: "runtime: final_message",
                    details: { turn, finalMessage: decision.text },
                  })
                  .pipe(Effect.either);
                if (resolveExit._tag === "Left") {
                  // The transition matrix blocked the resolve (audit L1):
                  // a manager took the ticket over mid-tick. The person owns
                  // the conversation now — hold, don't fight.
                  if (
                    (resolveExit.left as { readonly _tag?: string })._tag ===
                    "InvalidStatusTransition"
                  ) {
                    return { type: "PausedForHumanTakeover" } as const;
                  }
                  // Anything else propagates to the outer classifier
                  // (Failed retryable — pg-boss retries).
                  return yield* Effect.fail(resolveExit.left);
                }
                current = resolveExit.right;
                // The lifecycle writer can REFUSE to resolve (its bypass-proof
                // identity backstop) and park the ticket for a human instead. When
                // it does, the ticket did not resolve — report the takeover, not
                // Completed, so the outer classifier doesn't treat the tick as a
                // clean close.
                if (current.status !== "resolved" && current.status !== "archived") {
                  return {
                    type: "HumanTakeoverRequired",
                    reason: "resolve blocked: ticket parked for a human",
                  } as const;
                }
              }
              return { type: "Completed" } as const;
            }

            if (decision.type === "handoff") {
              // Same allowlist as the `agent.handoff` pseudo-tool below
              // (audit L13): a decision-level handoff to an agent outside the
              // effective handoffs (static ∪ Phase-C custom inbound) is blocked,
              // audited, and the loop continues with the current agent.
              const allowed = effectiveHandoffIds(agent, allSpecialists).has(
                decision.targetAgent as string,
              );
              if (!allowed) {
                yield* tx.run(
                  audit.record({
                    tenantId: current.tenantId,
                    ticketId: current.id,
                    actor: { type: "agent", id: agent.id },
                    action: "agent.handoff_blocked",
                    details: {
                      target: decision.targetAgent,
                      reason: decision.reason,
                      turn,
                    },
                  }),
                );
                continue;
              }
              const resolvedNext = yield* resolver.tryResolve(
                current.tenantId,
                decision.targetAgent,
              );
              if (!resolvedNext) {
                // Allowlisted but unresolvable (deleted custom agent / bad id):
                // audit and continue with the current agent rather than crash.
                yield* tx.run(
                  audit.record({
                    tenantId: current.tenantId,
                    ticketId: current.id,
                    actor: { type: "agent", id: agent.id },
                    action: "agent.handoff_blocked",
                    details: {
                      target: decision.targetAgent,
                      reason: decision.reason,
                      error: "handoff_target_unresolvable",
                      turn,
                    },
                  }),
                );
                continue;
              }
              agentBase = applyOverride(resolvedNext, overrideMap);
              const nextAgent = withScenario(agentBase, current.context);
              current = yield* tx.run(
                Effect.gen(function* () {
                  const updated = yield* tickets.update(current.id, {
                    currentAgentId: decision.targetAgent,
                  });
                  yield* audit.record({
                    tenantId: updated.tenantId,
                    ticketId: updated.id,
                    actor: { type: "agent", id: agent.id },
                    action: "agent.handoff",
                    details: {
                      target: decision.targetAgent,
                      reason: decision.reason,
                      turn,
                    },
                  });
                  return updated;
                }),
              );
              agent = nextAgent;
              continue;
            }

            if (decision.type === "wait_for_customer") {
              // Not wired in Phase 1 — park the ticket durably instead of
              // returning a result the worker merely logs (audit L4).
              yield* escalateToHuman(current.id, "wait_for_customer_not_wired", {
                turn,
              });
              return {
                type: "HumanTakeoverRequired",
                reason: "wait_for_customer not wired in Phase 1",
              } as const;
            }

            if (decision.type === "escalate_supplier") {
              yield* escalateToHuman(
                current.id,
                "escalate_supplier_not_wired",
                { turn },
              );
              return {
                type: "HumanTakeoverRequired",
                reason: "escalate_supplier not wired in Phase 1",
              } as const;
            }

            const toolStep = yield* executeToolCall(
              decision,
              agent,
              current,
              turn,
            );
            agent = toolStep.agent;
            current = toolStep.current;
            if (toolStep.done) {
              return toolStep.done;
            }
            // `scenarioKey` is provisional: ticket.update_context can select or
            // reroute it inside this loop. Refresh the dedicated trusted
            // playbook for the very next model turn. Rebuild from the clean
            // binding so stale playbooks are replaced, not accumulated;
            // `messages` remains untouched and retains all tool history.
            if (
              decision.type === "tool_call" &&
              decision.tool === "ticket.update_context"
            ) {
              // The context tool's compact result does not echo the full
              // context. Its validated input is the successful patch we just
              // applied, so fold the selected scenario into the in-memory
              // ticket immediately; the rest of the accumulated context and
              // the complete message/tool history remain intact.
              const selectedScenario = (
                decision.input as { readonly scenarioKey?: unknown }
              ).scenarioKey;
              if (typeof selectedScenario === "string") {
                current = {
                  ...current,
                  context: {
                    ...current.context,
                    scenarioKey: selectedScenario,
                  },
                };
              }
            }
          }

          // Turn budget exhausted — park the ticket durably (audit L4). Guard
          // against clobbering a terminal status a tool legitimately set on
          // the final turn.
          // Autonomous loop: if the agent queued gated actions before running
          // out of turns, don't throw that work away — park the bundle for
          // approval (the queued reply, if any, still goes out on approve).
          if (
            agent.autonomousLoop &&
            queuedApprovals.length > 0 &&
            current.status !== "resolved" &&
            current.status !== "archived" &&
            current.status !== "human_takeover" &&
            current.status !== "waiting_for_approval"
          ) {
            return yield* parkQueuedBundle(
              current,
              agent,
              agent.maxTurnsPerTick,
            );
          }
          if (
            current.status !== "resolved" &&
            current.status !== "archived" &&
            current.status !== "human_takeover"
          ) {
            yield* escalateToHuman(current.id, "max_turns_exceeded", {
              maxTurnsPerTick: agent.maxTurnsPerTick,
            });
          }
          return {
            type: "HumanTakeoverRequired",
            reason: "max_turns_exceeded",
          } as const;
        });

        // Resolve the ticket's Shopify customer from its stamped identifiers
        // (email → phone → name) and stamp the canonical `shopifyCustomerId`
        // when it isn't set yet — on EVERY tick, not just at creation. So a ticket
        // whose customer was identified only by phone/name (a merchant
        // pencil-edit, or a RESTART of an old ticket where the creation-time email
        // lookup missed because the order was placed under a different address)
        // gets the id that `shopify.find_customer_order` and the
        // order/customer-mismatch guard both key on. Idempotent (skips once
        // stamped) + best-effort (each leg fails to null; a write failure just
        // leaves it unstamped and the tick proceeds).
        //
        // The Shopify lookups are uncached network calls, so a ticket with
        // identifiers but NO Shopify match (e.g. a pre-sales emailer with no
        // account) would otherwise repeat them on every tick. A negative-attempt
        // marker (`customerResolutionTriedFor`, keyed on the exact identifier
        // set) records a miss so later ticks skip the lookup, while a change to
        // the identifiers produces a new key and re-triggers. Trade-off: if the
        // same customer becomes resolvable under UNCHANGED identifiers mid-ticket,
        // we won't retry — an acceptable miss vs. hammering the API each tick.
        const ensureCustomerResolved = Effect.gen(function* () {
          const ctx = working.context as Record<string, unknown>;
          const existing = ctx["shopifyCustomerId"];
          if (typeof existing === "string" && existing.length > 0) return;
          const ctxStr = (k: string): string | null => {
            const v = ctx[k];
            return typeof v === "string" && v.trim().length > 0
              ? v.trim()
              : null;
          };
          const cEmail = ctxStr("customerEmail");
          const cPhone = ctxStr("customerPhone");
          const cName = ctxStr("customerName");
          if (!cEmail && !cPhone && !cName) return;
          const attemptKey = JSON.stringify([cEmail, cPhone, cName]);
          if (ctx["customerResolutionTriedFor"] === attemptKey) return;
          const orNull = (
            eff: Effect.Effect<
              { readonly id: string } | null,
              unknown,
              never
            >,
          ) => eff.pipe(Effect.catchAll(() => Effect.succeed(null)));
          let customer = cEmail
            ? yield* orNull(shopify.searchByEmail(working.tenantId, cEmail))
            : null;
          if (!customer && cPhone) {
            customer = yield* orNull(
              shopify.searchByPhone(working.tenantId, cPhone),
            );
          }
          if (!customer && cName) {
            customer = yield* orNull(
              shopify.searchByName(working.tenantId, cName),
            );
          }
          // Missed: record the attempt so the next tick skips the lookup unless
          // the identifiers change. Best-effort — a write failure just retries.
          if (!customer) {
            working = yield* tickets
              .update(working.id, {
                context: {
                  ...ctx,
                  customerResolutionTriedFor: attemptKey,
                } as never,
              })
              .pipe(Effect.catchAll(() => Effect.succeed(working)));
            return;
          }
          working = yield* tickets
            .update(working.id, {
              context: { ...ctx, shopifyCustomerId: customer.id } as never,
            })
            .pipe(Effect.catchAll(() => Effect.succeed(working)));
        });

        if (event.type === "approval.approved") {
          return yield* resumeApprovedTool(event);
        }
        if (event.type === "approval.rejected") {
          return yield* handleApprovalRejected(event);
        }
        yield* enrichTicket;
        yield* ensureCustomerResolved;
        const held = yield* checkParkGuards;
        if (held) {
          return held;
        }
        yield* maybeReopen;
        return yield* runAgentLoop;
      }).pipe(
        // Anything that escapes the tick (repo/DB failures, defects) is
        // worth retrying — pg-boss applies backoff and the dead-letter
        // consumer escalates after exhaustion (audit C1). Deterministic
        // dead-ends return Failed retryable:false explicitly above.
        Effect.catchAllCause((cause) =>
          Effect.succeed({
            type: "Failed",
            reason: `runtime error: ${String(cause)}`,
            retryable: true,
          } as const),
        ),
      );

    // C3: processed-message dedup around the tick. The check is a READ
    // at the top and the claim is only WRITTEN after the tick completes
    // — a retryable failure leaves the key unclaimed so pg-boss's retry
    // genuinely reprocesses the event (claiming up-front would turn
    // every transient failure into a silently dropped message).
    const tick = (event: DomainEvent): Effect.Effect<WorkflowResult, never> =>
      Effect.gen(function* () {
        const claimInput =
          event.type === "message.received" && Option.isSome(maybeProcessed)
            ? {
                tenantId: makeTenantId(event.tenantId),
                provider:
                  parseThreadId(event.threadId)?.provider ?? "gmail",
                messageId: event.payload.messageId,
                threadId: event.threadId as string,
              }
            : null;
        if (claimInput && Option.isSome(maybeProcessed)) {
          const dup = yield* maybeProcessed.value
            .seen(claimInput)
            .pipe(Effect.catchAll(() => Effect.succeed(false)));
          if (dup) {
            return { type: "Completed" } as const;
          }
        }
        // Blocked-senders gate: inbound mail whose From or Reply-To matches
        // the tenant's blocklist is dropped before ANY ticket work — no
        // ticket row, no advisory lock, no agent tick (the whole point is
        // saving the LLM spend on marketing/spam mail). Fail-open: a
        // settings read failure must never silently drop customer mail.
        // The loaded settings are threaded into tickBody so a normal
        // inbound tick still reads the tenants row exactly once.
        let preloadedSettings: TenantSettings | null = null;
        let blocked = false;
        if (event.type === "message.received") {
          preloadedSettings = yield* tenantRepo
            .getSettings(makeTenantId(event.tenantId))
            .pipe(Effect.catchAll(() => Effect.succeed(null)));
          if (
            preloadedSettings &&
            isBlockedSender(
              preloadedSettings.blockedSenders ?? defaultBlockedSenders,
              [event.payload.from.email, event.payload.replyTo?.email],
            )
          ) {
            blocked = true;
            // Log ids only, not the address itself (audit-redaction
            // convention: no customer PII in operational logs).
            yield* Effect.logInfo(
              "inbound message dropped: sender is on the tenant blocklist",
            ).pipe(
              Effect.annotateLogs({
                tenantId: event.tenantId,
                threadId: String(event.threadId),
                messageId: event.payload.messageId,
              }),
            );
          }
        }
        // Per-ticket serialization (audit L2): the queue keys
        // message.received by THREAD and approval/timer/resume events by
        // TICKET, so two events for the same ticket can run concurrently
        // across those keys (a customer reply racing the manager's
        // approval → double reply). Hold a cluster-wide advisory lock on
        // the ticket for the whole tick; a not-yet-created ticket locks on
        // its thread key instead (creation itself is guarded by the
        // unique (tenant, thread) index).
        // A blocked message still falls through to the claim below so a
        // Pub/Sub redelivery doesn't re-run the settings read.
        let result: WorkflowResult;
        if (blocked) {
          result = { type: "Completed" };
        } else {
          const lockKey = yield* deriveTickLockKey(event, tickets);
          result = lockKey
            ? yield* tx.withLock(lockKey, tickBody(event, preloadedSettings))
            : yield* tickBody(event, preloadedSettings);
        }
        if (
          claimInput &&
          Option.isSome(maybeProcessed) &&
          !(result.type === "Failed" && result.retryable)
        ) {
          // Best-effort: a failed claim just means the next duplicate
          // runs a redundant tick (at-least-once, same as before C3).
          yield* maybeProcessed.value
            .claim(claimInput)
            .pipe(Effect.catchAll(() => Effect.succeed("new" as const)));
        }
        return result;
      });

    return AgentRuntime.of({
      handleEvent: tick,
    });
  }),
);

export const AgentRuntimeDefault = Layer.provideMerge(
  AgentRuntimeLayer,
  TicketLifecycleWriterLive,
);
