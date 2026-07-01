import { Context, Effect, Either, Layer, Option, Schema } from "effect";
import {
  PermissionService,
  ToolRegistry,
  type AgentConfig,
  type AnyTool,
  type Approval,
  type ApprovalId,
  type ApprovalRiskLevel,
  type CaseChannel,
  type ChatMessage,
  type DomainEvent,
  type InboundMessage,
  type LLMDecision,
  type LLMError,
  type TenantId,
  type ThreadId,
  type ToolContext,
  type WorkflowResult,
  summarizePhotoSignals,
  wrapUntrusted,
  UNTRUSTED_PREAMBLE,
  AgentId as makeAgentId,
  TenantId as makeTenantId,
  ThreadId as makeThreadId,
} from "@support-agent/agent-core";
import { CaseRepository } from "./case-repository.js";
import { AuditLogService } from "./audit-log.js";
import { ApprovalService } from "./approval-service.js";
import { LLMService } from "./llm-service.js";
import { ShopifyService } from "./shopify-service.js";
import { TransactionRunner } from "./transaction-runner.js";
import { PlatformMailService } from "./platform-mail.js";
import {
  MerchantNotificationService,
  approvalRequestedNotification,
  humanTakeoverNotification,
  type MerchantNotification,
} from "./merchant-notification.js";
import { ImageHashStore, type SimilarImageHit } from "./image-hash-store.js";
import { ApprovalLinkConfig } from "./approval-link-config.js";
import { buildApprovalNotification } from "./approval-notification.js";
import {
  TenantAgentOverridesService,
  type AgentOverride,
} from "./tenant-agent-overrides.js";
import { AgentResolver } from "./agent-resolver.js";
import {
  TenantRepository,
  defaultResolutionPolicy,
  type TenantSettings,
} from "./tenant-repository.js";
import { parseRefundAmount } from "./permission-service-live.js";
import {
  ProcessedMessageStore,
  ToolExecutionStore,
} from "./idempotency-store.js";
import { parseThreadId } from "./conversation-thread-id.js";
import { ConversationService } from "./conversation-service.js";
import { KnowledgeBaseService } from "./knowledge-base.js";
import {
  REPLY_DELIVERY_FAILED_FLAG,
  isReplyDeliverySendFailure,
} from "./reply-delivery.js";
import {
  CaseLifecycleWriter,
  CaseLifecycleWriterLive,
} from "./case-lifecycle-writer.js";


// ------------------------------------------------------------
// Pure, side-effect-free helpers live in agent-runtime-helpers.ts.
// Re-exported here so the package's public surface (and existing
// test imports from "./agent-runtime.js") stay unchanged; imported
// by name for use in the Layer below.
// ------------------------------------------------------------
export * from "./agent-runtime-helpers.js";
import {
  eventToCaseLookup,
  buildSystemPrompt,
  buildInitialMessages,
  inboundCustomerEmail,
  renderThreadTranscript,
  executionKeyFor,
  toolCallTimeoutMs,
  deliveryScopeFor,
  inboundReplyCandidateIds,
  refundAuditDetails,
  toolFailureAuditDetail,
  deriveTickLockKey,
  refundCustomerMismatchFlag,
  readRiskFlags,
  applyScenarioSteering,
  applyResolutionAgentEntry,
  SCENARIO_RESOLUTION_AGENT_ID,
  hasUnverifiedOrderMismatch,
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

const AgentRuntimeLayer = Layer.effect(
  AgentRuntime,
  Effect.gen(function* () {
    const cases = yield* CaseRepository;
    const audit = yield* AuditLogService;
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
    const lifecycle = yield* CaseLifecycleWriter;
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
    // don't, in which case the knowledge-base title header is simply omitted.
    // The `knowledge.search` tool resolves the service itself at execute time.
    const maybeKnowledge = yield* Effect.serviceOption(KnowledgeBaseService);
    // Optional — captured at layer-build time so `tick` can close over it.
    // Present in the worker (which wires ImageHashStoreLive); absent in the
    // many test layers that don't, in which case duplicate-photo detection
    // is simply skipped.
    const maybeImageHashStore = yield* Effect.serviceOption(ImageHashStore);
    // Optional conversation connector. Present in the worker (which wires a
    // ConversationRouter); absent in lean test layers. Used ONLY to pre-fetch
    // the thread on a `case.resumed` tick so the resumed agent (esp. triage,
    // which lacks the conversation.fetch_thread tool) sees the whole
    // conversation + what was already done. Strictly best-effort — a fetch
    // failure must never break a resume.
    const maybeConversation = yield* Effect.serviceOption(ConversationService);
    // Optional idempotency stores (audit C2/C3) — present in the worker,
    // absent in lean test layers (which then skip the dedup, as before).
    const maybeProcessed = yield* Effect.serviceOption(ProcessedMessageStore);
    const maybeExecutions = yield* Effect.serviceOption(ToolExecutionStore);
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

    // `applyOverride` (a pure module-level helper, defined above) overlays the
    // per-(tenant, agent) override row onto the in-code AgentConfig before each
    // turn — model, appended system prompt, and per-tool permission toggles.

    const tickBody = (
      event: DomainEvent,
    ): Effect.Effect<WorkflowResult, never> =>
      Effect.gen(function* () {
        const lookup = eventToCaseLookup(event);
        if (!lookup) {
          return {
            type: "Failed",
            reason: `event type ${event.type} not yet supported`,
            retryable: false,
          } as const;
        }

        // 1+2. Load/create case and audit event arrival in one tx
        // (master-plan §4 invariant: event → case write must be atomic
        // with audit). Subsequent per-turn writes happen outside this tx;
        // a fully transactional tick is deferred until we can scope an LLM
        // call outside the SQL tx without holding a connection open.
        const { row: caseRow, wasCreated } = yield* tx.run(
          Effect.gen(function* () {
            let row;
            let wasCreated = false;
            if (lookup.kind === "load") {
              row = yield* cases.getById(lookup.caseId as never);
            } else if (lookup.kind === "create") {
              row = yield* cases.create({
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
              // same case and just appends another tick (Audit log will
              // show double `event.received` but no double-create).
              const existing = yield* cases.findByThreadId(
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
                // new case, correlate by the message-id index: the reply's
                // In-Reply-To / References point at a message we already
                // recorded for some case (a prior inbound, or our own outbound
                // reply). This is what keeps a reply whose client reordered or
                // dropped the `References` chain from splitting off a duplicate
                // case (the IMAP `references[0]` thread-root is unreliable).
                const candidateIds =
                  event.type === "message.received"
                    ? inboundReplyCandidateIds(event.payload)
                    : [];
                const byMessageId =
                  candidateIds.length > 0
                    ? yield* cases.findByMessageIds(
                        makeTenantId(lookup.tenantId),
                        candidateIds,
                      )
                    : null;
                if (byMessageId) {
                  // Attach to the existing case; keep its stored threadId so
                  // outbound replies keep threading through the original root.
                  row = byMessageId;
                } else {
                  row = yield* cases.create({
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
              caseId: row.id,
              actor: { type: "system", id: "runtime" },
              action: "event.received",
              details: { eventType: event.type },
            });
            // Index this inbound message id so a later reply that cites it —
            // even one whose own References never reach the thread root —
            // resolves back to this case. Best-effort: a recording hiccup must
            // not roll back the case create + audit it shares this tx with.
            if (
              (event.type === "message.received" ||
                event.type === "customer.replied") &&
              event.payload.messageId
            ) {
              yield* cases
                .recordMessageId({
                  tenantId: row.tenantId,
                  caseId: row.id,
                  messageId: event.payload.messageId,
                  direction: "inbound",
                })
                .pipe(Effect.catchAll(() => Effect.void));
            }
            return { row, wasCreated };
          }),
        );

        let working = caseRow;

        // Park the case in `human_takeover` with an audit row, in one tx.
        // Every path that returns `HumanTakeoverRequired` must leave the
        // case durably parked (audit L4) — a result the worker merely logs
        // is invisible to the dashboard and the case dangles forever.
        const escalateToHuman = (
          caseId: typeof working.id,
          reason: string,
          details: Record<string, unknown> = {},
        ) =>
          Effect.gen(function* () {
            const updated = yield* lifecycle.escalateToHuman({
              caseId,
              tenantId: working.tenantId,
              actor: { type: "system", id: "agent-runtime" },
              reason,
              details,
            });
            // Ping the merchant AFTER the park committed (and outside the
            // tx): the case just became theirs.
            yield* notifyMerchant(
              updated.tenantId,
              humanTakeoverNotification({
                caseId: updated.id,
                subject: updated.subject,
                reason,
              }),
            );
            return updated;
          });

        // Index the RFC Message-ID of an outbound customer reply so a later
        // inbound reply that cites it (In-Reply-To / References) correlates
        // back to this case — even when the customer's client truncates the
        // `References` chain to just our message and the derived thread-root
        // no longer matches. Best-effort: a recording failure never fails the
        // send (the customer already got the email). `conversation.reply` /
        // `ask_customer` return `{ id, threadId, sentAt }`; the dedup short-
        // circuit returns `{ deduped: true }`, which has no `id` and is skipped.
        const recordOutboundReplyId = (
          caseRow: typeof working,
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
            yield* cases
              .recordMessageId({
                tenantId: caseRow.tenantId,
                caseId: caseRow.id,
                messageId: id,
                direction: "outbound",
              })
              .pipe(Effect.catchAll(() => Effect.void));
          });

        // Add a single risk-flag to the case context (deduped), best-effort:
        // a write failure degrades to the unchanged row rather than aborting.
        const addRiskFlag = (row: typeof working, flag: string) =>
          Effect.gen(function* () {
            const existing = readRiskFlags(row.context);
            if (existing.includes(flag)) return row;
            return yield* cases
              .update(row.id, {
                context: { ...row.context, riskFlags: [...existing, flag] } as never,
              })
              .pipe(Effect.catchAll(() => Effect.succeed(row)));
          });

        // A customer-reply (`conversation.reply` / `ask_customer`) send FAILED.
        // Don't lose it and don't let the case resolve as if it went out:
        //   1. persist the verbatim draft into the reply-delivery outbox so the
        //      worker sweep + the dashboard "Retry sending email" button can
        //      re-send the SAME email (no LLM re-run);
        //   2. stamp the `reply_delivery_failed` risk flag so the dashboard
        //      shows it + the merchant knows the customer wasn't reached;
        //   3. park the case in `human_takeover` (NEEDS ATTENTION, never
        //      resolved) — a successful retry later auto-resolves it.
        // All recovery writes succeed together. If the durable draft capture
        // fails, the tick fails retryably so the worker can redeliver instead
        // of parking a case with no resend path.
        const parkForReplyDeliveryFailure = (
          caseRow: typeof working,
          agentId: string,
          toolName: string,
          draftInput: unknown,
          errLeft: unknown,
          executionKey: string,
        ) =>
          Effect.gen(function* () {
            const updated = yield* lifecycle.parkForReplyDeliveryFailure({
              caseId: caseRow.id,
              tenantId: caseRow.tenantId,
              agentId,
              tool: toolName,
              draftInput,
              error: errLeft,
              executionKey,
            });
            yield* notifyMerchant(
              updated.tenantId,
              humanTakeoverNotification({
                caseId: updated.id,
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
        // the agent's job is done and the case resolves. When a gated
        // tool is mid-workflow (`refund.create` followed by a reply),
        // widen this branch to push the tool result into a fresh tick
        // and re-enter the agent loop.
        // Execute ONE approved approval row: re-validate the input, re-check
        // policy (deny-only), dedup, run the tool, audit. Returns a terminal
        // WorkflowResult on any problem (so bundle resume STOPS and the case
        // parks for a human), or `{ ok, tool, result }` on success — the case is
        // NOT resolved here. The caller decides the case outcome once every
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
              const recheck = yield* perms.check({
                tenantId: working.tenantId,
                agent: applyOverride(resumeAgent.value, resumeOverrides),
                tool: toolToRun,
                payload: decodedInput.right,
                caseId: working.id,
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
              // the case; nothing to redo here.
              return {
                type: "HumanTakeoverRequired",
                reason: `approved tool ${approval.tool} failed`,
              } as const;
            }
            const ctx: ToolContext = {
              tenantId: working.tenantId,
              caseId: working.id,
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
                  caseId: working.id,
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
              yield* tx.run(
                Effect.gen(function* () {
                  yield* audit.record({
                    tenantId: working.tenantId,
                    caseId: working.id,
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
                        caseId: working.id,
                        callId: executionKey,
                        tool: approval.tool,
                        resultOk: result._tag === "Right",
                      })
                      .pipe(Effect.catchAll(() => Effect.void));
                  }
                }),
              );
              exec = result;
            }
            if (exec._tag === "Left") {
              // Tool failed AFTER approval — park the case in human_takeover
              // so someone can intervene. The approval row is already
              // approved, which is the right audit shape (the manager said
              // yes; the platform tried; the platform failed). Without the
              // transition the case dangles in `waiting_for_approval` with no
              // pending row and nothing surfaces the failure (audit L4).
              //
              // A customer-reply SEND failure is special: the approved draft is
              // captured into the reply-delivery outbox (so the worker sweep + the
              // dashboard "Retry sending email" button can re-send the SAME email)
              // and the case is flagged `reply_delivery_failed` — otherwise it's a
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
            // A manager takeover means the human owns the case now. Approval
            // events can arrive late or race with takeover/reject/manual-status
            // actions; never let a stale approval execute tools or try to move
            // the case out from under the human.
            if (working.status === "human_takeover") {
              yield* tx.run(
                audit.record({
                  tenantId: working.tenantId,
                  caseId: working.id,
                  actor: { type: "system", id: "runtime" },
                  action: "approval.stale_delivery_skipped",
                  details: {
                    approvalId: trigger.id,
                    status: working.status,
                  },
                }),
              );
              return { type: "PausedForHumanTakeover" } as const;
            }
            // Duplicate-delivery guard (audit C2): pg-boss is at-least-once.
            // A re-delivered `approval.approved` for a case that already ran
            // to completion must NOT execute the gated tool(s) a second time —
            // that's a double refund / double customer email.
            if (working.status === "resolved") {
              yield* tx.run(
                audit.record({
                  tenantId: working.tenantId,
                  caseId: working.id,
                  actor: { type: "system", id: "runtime" },
                  action: "approval.duplicate_delivery_skipped",
                  details: { approvalId: trigger.id },
                }),
              );
              return { type: "Completed" } as const;
            }
            // Bundle resume (slice 4d): the autonomous loop can queue SEVERAL
            // gated actions on one case, all approved together — one
            // `approval.approved` event executes the whole bundle. Gather every
            // already-approved row for the case and run them in creation order
            // (= the order the agent proposed them). The legacy single-approval
            // path is just a bundle of one. Each row's own execution marker
            // keeps a redelivery idempotent; the first failure parks the case
            // and STOPS the bundle (the rest don't run).
            const all = yield* approvals
              .listForCase(working.tenantId, working.id)
              .pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<Approval>)));
            const approvedRows = all.filter((a) => a.status === "approved");
            let bundle = approvedRows;
            let usedFallback = false;
            if (bundle.length === 0) {
              // The trigger hasn't been observed as `approved` yet (a lean
              // ApprovalService without listForCase, or an event that raced the
              // approve write): fall back to running it as a singleton if it's
              // still runnable. A rejected/cancelled/expired row never executes.
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
              bundle = [trigger];
              usedFallback = true;
            }
            const ran: Array<{ readonly tool: string; readonly result: unknown }> =
              [];
            for (const approval of bundle) {
              const outcome = yield* executeOneApproval(approval, event);
              // A WorkflowResult (no `ok`) means this action failed / couldn't
              // run; the case is already parked. Stop — don't run later actions.
              if (!("ok" in outcome)) return outcome;
              ran.push({ tool: outcome.tool, result: outcome.result });
            }
            // Per-action approval: NEVER resolve a case that still has actions
            // awaiting a decision. The operator may approve some now and decide
            // the rest later; keep the case parked until every row is decided.
            const stillPending = usedFallback
              ? []
              : all.filter((a) => a.status === "pending");
            if (stillPending.length > 0) {
              return {
                type: "PausedWaitingForApproval",
                approvalId: stillPending[0]!.id,
              } as const;
            }
            // All actions decided. If one was a supplier escalation, the case is
            // now waiting on the SUPPLIER (not done): park `waiting_for_supplier`
            // so the agent re-engages on `supplier.updated`, exactly like the
            // in-loop escalate path. A `no_supplier` escalate (escalated:false)
            // is not a wait — it falls through to resolve.
            const escalatedToSupplier = ran.some(
              (r) =>
                r.tool === "supplier.escalate" &&
                (r.result as { readonly escalated?: boolean } | null)
                  ?.escalated === true,
            );
            if (escalatedToSupplier) {
              working = yield* lifecycle.parkWaitingForSupplier({
                caseId: working.id,
                tenantId: working.tenantId,
                agentId: trigger.agentId,
                tool: "supplier.escalate",
                callId: `approval-${trigger.id}`,
              });
              return { type: "PausedWaitingForSupplier" } as const;
            }
            // Nothing left to wait on — resolve once.
            working = yield* lifecycle.resolve({
              caseId: working.id,
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
            working = yield* lifecycle.escalateToHuman({
              caseId: working.id,
              tenantId: working.tenantId,
              actor: { type: "user", id: event.managerId },
              reason: "approval rejected",
              details: {
                approvalId: event.approvalId,
                reason: event.reason ?? null,
              },
            });
            // Confirmation ping: rejecting the draft makes the case theirs.
            yield* notifyMerchant(
              working.tenantId,
              humanTakeoverNotification({
                caseId: working.id,
                subject: working.subject,
                reason: "approval rejected",
              }),
            );
            return {
              type: "HumanTakeoverRequired",
              reason: "approval rejected",
            } as const;
        });

        const enrichCase = Effect.gen(function* () {
          // 2a. Customer identification — only on a freshly-created case
          // bound to an inbound message. Best-effort: the tick proceeds
          // even if Shopify is down / not configured / has no match for
          // this email. Persists `customerEmail` (always when we have one)
          // and `shopifyCustomerId` (only on a positive match) into the
          // case context. Specialists like refund-review can read these
          // without firing their own searchByEmail per tick.
          if (wasCreated && event.type === "message.received") {
            // Prefer Reply-To over From: relay-delivered mail (Shopify
            // contact form) carries the real customer in Reply-To, so the
            // stamped customerEmail must point at the human, not the relay.
            const email = inboundCustomerEmail(event.payload);
            if (email) {
              const resolved = yield* shopify
                .searchByEmail(working.tenantId, email)
                .pipe(Effect.either);
              const contextPatch: Record<string, unknown> = {
                ...working.context,
                customerEmail: email,
              };
              if (resolved._tag === "Right" && resolved.right) {
                contextPatch["shopifyCustomerId"] = resolved.right.id;
              }
              working = yield* cases
                .update(working.id, { context: contextPatch as never })
                .pipe(
                  Effect.catchAll(() => Effect.succeed(working)),
                );
            }
          }

          // 2a-bis. Order-status identity verification — when a customer replies
          // to a case we flagged as an order/customer mismatch, check (in the
          // runtime, never the model) whether their reply states the email the
          // order was placed under. A match clears the disclosure gate so the
          // status reply can proceed automatically; a miss leaves the case gated
          // (the reply still routes to human approval via the backstop at the
          // permission check). Keyed off `pendingOrderEmail`, persisted at
          // detection time. Best-effort: a write failure simply leaves the gate
          // up. The model cannot set `identityVerified`/`verifiedCustomerEmail` —
          // they're stamped here and absent from the case.update_context
          // allowlist — so a prompt-injected reply body can't fake a pass. The
          // saved `verifiedCustomerEmail` is the TRUSTED order email, surfaced on
          // the case (Context panel + Customer card) once the requester confirms
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
              working = yield* cases
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
                  caseId: working.id,
                  actor: { type: "system", id: "runtime" },
                  action: "case.identity_verified",
                  details: { method: "order_email_confirmed" },
                })
                .pipe(Effect.catchAll(() => Effect.void));
            }
          }

          // 2b. Photo signals — when an inbound message carries image
          // attachments, stamp a per-case EXIF rollup onto the context. A
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
            // recent hashes. A near-match on ANOTHER case flags the re-used
            // "broken item" photo scam. Best-effort: store failures degrade
            // to no flag rather than aborting the tick.
            const maybeStore = maybeImageHashStore;
            const dupFlags: string[] = [];
            if (Option.isSome(maybeStore)) {
              const store = maybeStore.value;
              const seenCaseIds = new Set<string>();
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
                    caseId: working.id,
                    phash,
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
                  if (!seenCaseIds.has(hit.caseId)) {
                    seenCaseIds.add(hit.caseId);
                    dupFlags.push(`duplicate_photo_seen_in_case_${hit.caseId}`);
                  }
                }
                // Record this photo's hash so future uploads can match it.
                yield* store
                  .record({
                    tenantId: working.tenantId,
                    caseId: working.id,
                    phash,
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
              working = yield* cases
                .update(working.id, { context: patch as never })
                .pipe(Effect.catchAll(() => Effect.succeed(working)));
            }
          }
        });

        const checkParkGuards = Effect.gen(function* () {
          // 2.9. Hold events that arrive while an approval is still pending.
          // A case parked in `waiting_for_approval` must stay parked until
          // the manager decides (`approval.approved` / `approval.rejected`,
          // short-circuited above) or a human takes over out-of-band (which
          // cancels the approval without running the agent). ANY other event
          // that reaches here — the customer replying again on the same
          // thread, a follow-up timer firing — must NOT re-enter the agent
          // loop: a `final_message` (or a `case.update_status`) decision would
          // then resolve the case out from under the still-pending approval,
          // so the manager would see "resolved" for a draft they never
          // approved. We re-park instead. (If the status says
          // `waiting_for_approval` but no pending row exists — a stale /
          // inconsistent case — we fall through so the agent can still make
          // progress; the pending approval row is the source of truth.)
          if (working.status === "waiting_for_approval") {
            const pendingForCase = yield* approvals
              .listPending(working.tenantId)
              .pipe(Effect.catchAll(() => Effect.succeed([])));
            const open = pendingForCase.find((a) => a.caseId === working.id);
            if (open) {
              yield* tx.run(
                audit.record({
                  tenantId: working.tenantId,
                  caseId: working.id,
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

          // 2.95. Hold every event once a human has taken the case over.
          // `human_takeover` means a person owns this conversation; an inbound
          // customer reply, a follow-up timer, or any other event must NOT
          // re-enter the agent loop and answer over the human (the runtime
          // also has no message-history replay, so it would respond with only
          // the latest message as context — doubly wrong). The case stays
          // parked until a manager hands it back from the dashboard, which
          // transitions it out of `human_takeover` so subsequent events flow
          // through normally. We record the held event for the audit trail.
          if (working.status === "human_takeover") {
            yield* tx.run(
              audit.record({
                tenantId: working.tenantId,
                caseId: working.id,
                actor: { type: "system", id: "runtime" },
                action: "event.held_human_takeover",
                details: { eventType: event.type },
              }),
            );
            return { type: "PausedForHumanTakeover" } as const;
          }

          // 2.96. Hold events while the case is parked on the supplier. A case in
          // `waiting_for_supplier` belongs to the warehouse until they respond, so
          // a stray customer reply or follow-up timer must NOT re-enter the agent
          // loop (the agent would answer the customer while the supplier still
          // owns the case — mirrors the approval/takeover park guards above). Only
          // `supplier.updated` (the supplier responded — the loop below drafts the
          // customer reply) and the human-control events (`manual.takeover` /
          // `case.resumed`) pass through.
          if (working.status === "waiting_for_supplier") {
            const passthrough =
              event.type === "supplier.updated" ||
              event.type === "manual.takeover" ||
              event.type === "case.resumed";
            if (!passthrough) {
              yield* tx.run(
                audit.record({
                  tenantId: working.tenantId,
                  caseId: working.id,
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
          // 2.97. Reopen a resolved case when the customer writes back on the
          // thread. The state machine permits `resolved → in_progress` (a reply
          // re-enters the loop) but nothing performed the transition: the case
          // stayed visually `resolved` while the agent re-ran, and a closing
          // `final_message` then short-circuited (status already resolved) so a
          // genuine re-engagement could finish invisibly. Transitioning here
          // surfaces the reopen on the timeline and lets the normal
          // resolve/await paths run against a coherent status. Only inbound
          // customer messages reopen; system events (timers, approvals) never
          // resurrect a resolved case.
          if (
            (event.type === "message.received" ||
              event.type === "customer.replied") &&
            working.status === "resolved"
          ) {
            working = yield* lifecycle.reopenForCustomerReply({
              caseId: working.id,
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
          const tenantSettings: TenantSettings | null = yield* tenantRepo
            .getSettings(working.tenantId)
            .pipe(Effect.catchAll(() => Effect.succeed(null)));
          // Knowledge-base document titles for the system-prompt header. Loaded
          // once per tick (titles only — the `knowledge.search` tool pulls the
          // bodies on demand). Absent service (test layers) → no titles; DB
          // failures fall back to an empty list so the runtime keeps going with
          // the bare prompt.
          const knowledgeTitles: ReadonlyArray<string> = Option.isSome(
            maybeKnowledge,
          )
            ? yield* maybeKnowledge.value
                .listTitles(working.tenantId)
                .pipe(
                  Effect.catchAll(() =>
                    Effect.succeed([] as ReadonlyArray<string>),
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
          // Resolve the case's current agent (built-in or custom). A miss means
          // the agent was deleted/disabled (or the id is otherwise unknown):
          // park the case for a human rather than letting an UnknownAgent crash
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
          // playbook header. Triage picks the scenario and stamps it on the case
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
          ): AgentConfig => {
            if (!a.autonomousLoop) return a;
            const key =
              typeof ctx["scenarioKey"] === "string"
                ? (ctx["scenarioKey"] as string)
                : null;
            if (!key) return a;
            const scenario = resolutionPolicy.scenarios.find(
              (s) => s.key === key,
            );
            // Steering only — tools/permissions are configured once on the agent
            // now, not clamped per scenario (2026-06-28). `applyScenarioEnvelope`
            // (the clamping variant) is retained + tested for the resurface path.
            return scenario ? applyScenarioSteering(a, scenario) : a;
          };
          // Resolution-agent-direct (2026-06-28): when the tenant has the
          // resolution agent enabled, inbound cases bound to the primary
          // (support-triage) run the scenario-resolution-agent DIRECTLY — it
          // picks the matching scenario itself (sets `scenarioKey`) and resolves
          // end-to-end. This replaces the old triage→handoff routing, whose
          // brittle classification step intermittently silently-resolved cases
          // (a weak triage model bailing to `final_message` instead of handing
          // off). Flag off → legacy triage + specialist routing is untouched.
          // (Supersedes `applyTriageScenarioRouting`, which is retained + tested
          // for the resurface path but no longer wired in.)
          const resolutionAgentOn =
            tenantSettings?.resolutionAgentEnabled === true;
          let entryBase: AgentConfig = applyOverride(resolved, overrideMap);
          if (resolutionAgentOn && (resolved.id as string) === "support-triage") {
            const resolutionAgent = yield* resolver.tryResolve(
              working.tenantId,
              makeAgentId(SCENARIO_RESOLUTION_AGENT_ID),
            );
            if (resolutionAgent) {
              entryBase = applyOverride(resolutionAgent, overrideMap);
              // Persist the entry binding so the dashboard shows the agent that
              // is actually handling the case and a later resume runs it
              // directly (resolves straight to the resolution agent, no re-swap).
              // One-time write per entry; a restart-from-triage rebinds to
              // support-triage and re-enters here.
              working = yield* tx.run(
                Effect.gen(function* () {
                  const updated = yield* cases.update(working.id, {
                    currentAgentId: makeAgentId(SCENARIO_RESOLUTION_AGENT_ID),
                  });
                  yield* audit.record({
                    tenantId: updated.tenantId,
                    caseId: updated.id,
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
          if (
            resolutionAgentOn &&
            (entryBase.id as string) === SCENARIO_RESOLUTION_AGENT_ID
          ) {
            entryBase = applyResolutionAgentEntry(entryBase, resolutionPolicy);
          }
          let agent: AgentConfig = withScenario(entryBase, working.context);
          // On a resume (dashboard retry / restart-from-triage / hand-back) the
          // agent starts blind — there's no inbound payload. Pre-fetch the full
          // thread so it re-orients on the ACTUAL conversation and what was
          // already done, instead of being told to fetch it itself (triage has
          // no such tool). Best-effort: a connector hiccup or a lean layer
          // without ConversationService falls back to the fetch directive.
          let resumeTranscript: string | null = null;
          if (
            event.type === "case.resumed" &&
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
          // targets an order belonging to a different customer than the case
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
                  caseId: current.id,
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
                    caseId: current.id,
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
                  caseId: current.id,
                  tenantId: current.tenantId,
                  actor: { type: "system", id: "agent-runtime" },
                  reason: "llm_insufficient_credits",
                  details: { provider: err.provider },
                });
                yield* notifyMerchant(
                  current.tenantId,
                  humanTakeoverNotification({
                    caseId: current.id,
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
              // request, so park the case for a human instead of burning
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

          // Park the case in waiting_for_approval (approval row + transition +
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
              // on an un-parked case, so the agent could keep acting and a
              // second approval could be created. master-plan §4: the audit
              // write shares the transaction with the state change.
              const parked = yield* lifecycle.parkForApproval({
                caseId: current.id,
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
              current = parked.case_;

              // Fire the approval-link email + merchant ping. Best-effort: a
              // Resend outage, a tenant without `notificationEmail` configured,
              // or any other mail failure must NOT block the case. The approval
              // row is the source of truth and the dashboard picks it up
              // regardless; the maintenance cron re-sends this same
              // notification if the first send was dropped. `buildApprovalNotification`
              // is shared with that reminder path so the signed links + preview
              // can't drift. Each URL carries its OWN token with the action
              // bound into the HMAC (audit S3) — a reject link must not approve.
              const notification = buildApprovalNotification({
                approvalId: approval.id,
                tenantId: current.tenantId,
                caseId: current.id,
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
          // more QUEUED gated actions. Park the case ONCE in waiting_for_approval
          // (a single transition covering the whole bundle) and send ONE merchant
          // ping. The dashboard (slice 7) is the bundle approve/reject surface;
          // on approval the runtime executes the queued rows in order (slice 4d).
          const parkQueuedBundle = (current: typeof working, agent: AgentConfig, turn: number) =>
            Effect.gen(function* () {
              const parked = yield* lifecycle.parkForApprovalBundle({
                caseId: current.id,
                tenantId: current.tenantId,
                agentId: agent.id,
                approvalIds: queuedApprovals,
                turn,
              });
              yield* notifyMerchant(
                parked.tenantId,
                approvalRequestedNotification({
                  caseId: parked.id,
                  toolName: `${queuedApprovals.length} action${queuedApprovals.length === 1 ? "" : "s"}`,
                  draftSubject: parked.subject,
                  draftPreview: `${queuedApprovals.length} action${queuedApprovals.length === 1 ? "" : "s"} are queued and awaiting your approval.`,
                  approveUrl: `${linkConfig.baseUrl}/cases/${parked.id}`,
                  rejectUrl: `${linkConfig.baseUrl}/cases/${parked.id}`,
                }),
              );
              return {
                type: "PausedWaitingForApproval",
                approvalId: queuedApprovals[0]!,
              } as const;
            });

          // Run one tool_call decision: push the assistant message, intercept
          // agent.handoff, validate + dedup + permission-gate, then execute (or
          // park). Returns the (possibly handed-off) agent, the refreshed case,
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
                      caseId: current.id,
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
                      caseId: current.id,
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
                const targetAgent = withScenario(
                  applyOverride(resolvedTarget, overrideMap),
                  current.context,
                );
                current = yield* tx.run(
                  Effect.gen(function* () {
                    const updated = yield* cases.update(current.id, {
                      currentAgentId: targetAgentId,
                    });
                    yield* audit.record({
                      tenantId: updated.tenantId,
                      caseId: updated.id,
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
              // from the case's bound customer and, if so, stamp a risk flag onto
              // the case context. The approval card surfaces riskFlags as chips,
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
                caseId: current.id,
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
                // and drafts its reply conditionally. The case parks once, as a
                // bundle, when the loop ends (parkQueuedBundle).
                if (agent.autonomousLoop) {
                  const approval = yield* lifecycle.queueApproval({
                    caseId: current.id,
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
              // effect itself was never transactional). Tools that mutate case
              // state route those writes through their own lifecycle services.
              const ctx: ToolContext = {
                tenantId: current.tenantId,
                caseId: current.id,
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
              const exec = yield* tx.run(
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
                    caseId: current.id,
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
                        caseId: current.id,
                        callId: loopExecutionKey,
                        tool: tool.name,
                        resultOk: result._tag === "Right",
                      })
                      .pipe(Effect.catchAll(() => Effect.void));
                  }
                  return result;
                }),
              );

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
                    caseId: current.id,
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
                  // reply (it must NOT park a case nobody is working). The escalation
                  // row was written by the tool's service; here we park the case +
                  // audit in one tx, then end the tick. The case re-engages on
                  // `supplier.updated` (the consumer). Runs only when escalate
                  // resolved to `allow` (per-agent) — under the default `ask`, the
                  // permission gate above parks in waiting_for_approval instead.
                  current = yield* lifecycle.parkWaitingForSupplier({
                    caseId: current.id,
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
                // case's bound customer (refund scope guard).
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
                  // the tick, and a fail-open (null) result leaves the case alone.
                  if (current.context["classification"] === "where_is_order") {
                    const mismatchFlag = orderCustomerMismatchFlag(
                      email,
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
                      current = yield* cases
                        .update(current.id, { context: patch as never })
                        .pipe(Effect.catchAll(() => Effect.succeed(current)));
                    }
                  }
                }
                // Bind the resolved order's canonical GID to the case context as
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
                // them. Best-effort: a write failure leaves the case alone.
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
                if (resolvedOrder && !existingIsGid) {
                  const ref = orderContextRef(resolvedOrder);
                  if (ref) {
                    current = yield* cases
                      .update(current.id, {
                        context: {
                          ...current.context,
                          identifiedOrderId: ref,
                        } as never,
                      })
                      .pipe(Effect.catchAll(() => Effect.succeed(current)));
                  }
                }
                // The tool may have mutated the case (e.g. transitioned status).
                current = yield* cases.getById(current.id, current.tenantId);
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
                // case whose reply never reached the customer (the silent-delivery
                // bug). Capture the draft for retry, flag + park the case, and end
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
          // draft is enforced generally at approval-creation time (CaseLifecycle
          // Writer.parkForApproval / queueApproval call supersedeOlderDraft), so
          // it holds for every agent + path — not just this loop.

          for (let turn = 0; turn < agent.maxTurnsPerTick; turn++) {
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
                  knowledgeTitles,
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
            // into the audit row. The dashboard case detail rolls these
            // up across `llm.decision` rows to surface per-case totals;
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
              caseId: current.id,
              actor: { type: "agent", id: agent.id },
              action: "llm.decision",
              details: {
                turn,
                decisionType: decision.type,
                ...(usageDetails ? { usage: usageDetails } : {}),
              },
            });

            if (decision.type === "final_message") {
              if (current.status !== "resolved") {
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
                // triage) must never resolve a case with a bare final
                // message. Its only legitimate terminal move is
                // `agent.handoff` — after a successful handoff `agent` is the
                // specialist (handoffs: []), so this check no longer trips.
                // A still-routing agent that reaches final_message has failed
                // to route; silently resolving here would close the case with
                // nothing done (a triage classify → no order id → "done"
                // message used to leave customers with no reply). Park for a
                // human instead of swallowing the case. Keyed on `handoffs`,
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
                // final_message here closes a live case with nothing safely sent
                // (prod 3428f154: order-status-agent drafted a prose answer
                // instead of conversation.reply / ask_customer and the case
                // silently resolved). Park for a human, who can verify identity
                // and reply, instead of swallowing the case.
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
                // "case.resolved" audit in one tx (master-plan §4).
                const resolveExit = yield* lifecycle
                  .resolve({
                    caseId: current.id,
                    tenantId: current.tenantId,
                    actor: { type: "agent", id: agent.id },
                    reason: "runtime: final_message",
                    details: { turn, finalMessage: decision.text },
                  })
                  .pipe(Effect.either);
                if (resolveExit._tag === "Left") {
                  // The transition matrix blocked the resolve (audit L1):
                  // a manager took the case over mid-tick. The person owns
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
                // identity backstop) and park the case for a human instead. When
                // it does, the case did not resolve — report the takeover, not
                // Completed, so the outer classifier doesn't treat the tick as a
                // clean close.
                if (current.status !== "resolved") {
                  return {
                    type: "HumanTakeoverRequired",
                    reason: "resolve blocked: case parked for a human",
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
                    caseId: current.id,
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
                    caseId: current.id,
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
              const nextAgent = withScenario(
                applyOverride(resolvedNext, overrideMap),
                current.context,
              );
              current = yield* tx.run(
                Effect.gen(function* () {
                  const updated = yield* cases.update(current.id, {
                    currentAgentId: decision.targetAgent,
                  });
                  yield* audit.record({
                    tenantId: updated.tenantId,
                    caseId: updated.id,
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
              // Not wired in Phase 1 — park the case durably instead of
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
          }

          // Turn budget exhausted — park the case durably (audit L4). Guard
          // against clobbering a terminal status a tool legitimately set on
          // the final turn.
          // Autonomous loop: if the agent queued gated actions before running
          // out of turns, don't throw that work away — park the bundle for
          // approval (the queued reply, if any, still goes out on approve).
          if (
            agent.autonomousLoop &&
            queuedApprovals.length > 0 &&
            current.status !== "resolved" &&
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

        if (event.type === "approval.approved") {
          return yield* resumeApprovedTool(event);
        }
        if (event.type === "approval.rejected") {
          return yield* handleApprovalRejected(event);
        }
        yield* enrichCase;
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
        // Per-case serialization (audit L2): the queue keys
        // message.received by THREAD and approval/timer/resume events by
        // CASE, so two events for the same case can run concurrently
        // across those keys (a customer reply racing the manager's
        // approval → double reply). Hold a cluster-wide advisory lock on
        // the case for the whole tick; a not-yet-created case locks on
        // its thread key instead (creation itself is guarded by the
        // unique (tenant, thread) index).
        const lockKey = yield* deriveTickLockKey(event, cases);
        const result = lockKey
          ? yield* tx.withLock(lockKey, tickBody(event))
          : yield* tickBody(event);
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
  CaseLifecycleWriterLive,
);
