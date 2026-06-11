import { Context, Effect, Either, Layer, Option, Schema } from "effect";
import {
  AgentRegistry,
  PermissionService,
  ToolRegistry,
  type AgentConfig,
  type AnyTool,
  type ApprovalRiskLevel,
  type CaseChannel,
  type ChatMessage,
  type DomainEvent,
  type LLMDecision,
  type ThreadId,
  type ToolContext,
  type WorkflowResult,
  summarizePhotoSignals,
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
import { ImageHashStore, type SimilarImageHit } from "./image-hash-store.js";
import { ApprovalLinkConfig } from "./approval-link-config.js";
import { signApprovalToken } from "./approval-tokens.js";
import {
  TenantAgentOverridesService,
  type AgentOverride,
} from "./tenant-agent-overrides.js";
import {
  TenantRepository,
  type TenantSettings,
} from "./tenant-repository.js";
import { parseRefundAmount } from "./permission-service-live.js";
import {
  ProcessedMessageStore,
  ToolExecutionStore,
} from "./idempotency-store.js";
import { parseThreadId } from "./conversation-thread-id.js";
import { KnowledgeBaseService } from "./knowledge-base.js";

// ============================================================
// Helpers
// ============================================================

type CaseLookup =
  | { readonly kind: "load"; readonly caseId: string }
  | {
      readonly kind: "create";
      readonly tenantId: string;
      readonly channel: CaseChannel;
      readonly subject: string | null;
      readonly initialUserMessage: string | null;
    }
  | {
      readonly kind: "loadOrCreateByThread";
      readonly tenantId: string;
      readonly threadId: string;
      readonly channel: CaseChannel;
      readonly subject: string | null;
      readonly initialUserMessage: string | null;
    };

const eventToCaseLookup = (event: DomainEvent): CaseLookup | null => {
  switch (event.type) {
    case "ticket.created":
      return {
        kind: "create",
        tenantId: event.tenantId,
        channel: event.source,
        subject: event.payload.subject,
        initialUserMessage: event.payload.body,
      };
    case "customer.replied":
    case "approval.approved":
    case "approval.rejected":
    case "supplier.updated":
    case "timer.expired":
    case "manual.takeover":
    case "case.resumed":
      return { kind: "load", caseId: event.caseId };
    case "message.received":
      // The connector has already normalised this into a thread + body.
      // First message on a thread → create a case bound to the thread;
      // subsequent messages → resume the same case via `findByThreadId`.
      // Channel defaults to "email" because every connector that emits
      // this event today (Gmail; later Outlook / IMAP) is email-shaped;
      // when a non-email connector (SMS, helpdesk) ships, widen this.
      return {
        kind: "loadOrCreateByThread",
        tenantId: event.tenantId,
        threadId: event.threadId,
        channel: "email",
        subject: event.payload.subject,
        initialUserMessage: event.payload.bodyText,
      };
    case "tracking.changed":
      // Phase 1 does not implement lookup-by-order. (When a tracking-
      // change specialist lands, swap this for findByOrderId.)
      return null;
  }
};

/**
 * Build the system prompt the runtime hands to the LLM each turn.
 *
 * The prompt is `agent.promptTemplate`, optionally with one or more bracketed
 * headers appended. The `[Supplier escalation sheet: ...]` header is added when:
 *   1. The agent declares `supplier.add_sheet_row` in its tools array, AND
 *   2. The tenant has configured a `supplierEscalationSheet` in settings.
 * The `[Store knowledge base — ...]` header (listing the tenant's document
 * titles) is added under the same shape when the agent declares
 * `knowledge.search` AND the tenant has at least one knowledge document
 * (`knowledgeTitles`, loaded once per tick).
 *
 * Missing-package-agent's BRANCH A is the first user of this header — its
 * prompt checks for the bracketed line and conditionally calls
 * `supplier.add_sheet_row` before drafting the customer reply. Agents
 * that don't use the tool never see the header even when the tenant has
 * a sheet configured, so the prompt context stays minimal per agent.
 *
 * Pure helper — exported so a tiny unit test can pin the formatting
 * without spinning up the full runtime.
 */
export const buildSystemPrompt = (
  agent: Pick<AgentConfig, "tools" | "promptTemplate">,
  tenantSettings: TenantSettings | null,
  knowledgeTitles: ReadonlyArray<string> = [],
): string => {
  const headers: string[] = [];

  const sheet = tenantSettings?.supplierEscalationSheet ?? null;
  const usesSheetTool = agent.tools.some(
    (t) => (t as string) === "supplier.add_sheet_row",
  );
  if (sheet && usesSheetTool) {
    headers.push(
      `[Supplier escalation sheet: spreadsheetId=${sheet.spreadsheetId}, range=${sheet.range}]`,
    );
  }

  // Knowledge base: list the tenant's document titles so an agent that holds
  // the `knowledge.search` tool knows what's available and pulls full text on
  // demand. Same gating shape as the supplier header — only agents that
  // declare the tool see it, and only when the tenant actually has documents.
  const usesKnowledgeTool = agent.tools.some(
    (t) => (t as string) === "knowledge.search",
  );
  if (usesKnowledgeTool && knowledgeTitles.length > 0) {
    const titles = knowledgeTitles.map((t) => `"${t}"`).join(", ");
    headers.push(
      `[Store knowledge base — call knowledge.search to read: ${titles}]`,
    );
  }

  if (headers.length === 0) {
    return agent.promptTemplate;
  }
  return `${agent.promptTemplate}\n\n${headers.join("\n\n")}`;
};

// Build a user-role ChatMessage from a text body + the inbound message's
// attachments. When the message carries any image attachments, the
// content becomes a parts array `[text, ...images]` so the LLM provider
// boundary can dispatch a multimodal request. Non-image attachments are
// dropped at this layer today — the runtime/agent surface only has a
// damaged-product use case for images so far; PDF/audio support lands
// when a specialist needs it.
const buildUserMessageFromInbound = (
  text: string,
  attachments: ReadonlyArray<import("@support-agent/agent-core").MessageAttachment>,
): ChatMessage => {
  const images = attachments.filter((a) => a.contentType.startsWith("image/"));
  if (images.length === 0) {
    return { role: "user", content: text };
  }
  return {
    role: "user",
    content: [
      { type: "text", text },
      ...images.map((a) => ({ type: "image" as const, attachment: a })),
    ],
  };
};

export const buildInitialMessages = (
  event: DomainEvent,
  caseRow: {
    readonly subject: string | null;
    readonly threadId: ThreadId | null;
    readonly context: Record<string, unknown>;
  },
): ChatMessage[] => {
  const caseSubject = caseRow.subject;
  if (event.type === "ticket.created") {
    const subject = event.payload.subject ?? caseSubject ?? "(no subject)";
    return [
      {
        role: "user",
        content: `Subject: ${subject}\n\n${event.payload.body}`,
      },
    ];
  }
  if (event.type === "customer.replied") {
    return [
      buildUserMessageFromInbound(
        event.payload.bodyText ?? "(empty reply)",
        event.payload.attachments,
      ),
    ];
  }
  if (event.type === "message.received") {
    // The payload IS the customer message — same shape as ticket.created
    // but from a connector instead of a synthetic publisher. We pass the
    // subject inline so the LLM sees thread context on turn 1, plus a
    // bracketed header carrying `threadId` and the customer email so
    // specialists (refund-review, etc.) can wire `conversation.reply`
    // without an extra `conversation.fetch_thread` round trip.
    const subject =
      event.payload.subject ?? caseSubject ?? "(no subject)";
    const header = `[Thread context: threadId=${event.threadId}, from=${event.payload.from.email}]`;
    const text = `${header}\n\nSubject: ${subject}\n\n${event.payload.bodyText}`;
    return [buildUserMessageFromInbound(text, event.payload.attachments)];
  }
  if (event.type === "case.resumed") {
    // A manager explicitly re-ran the case from the dashboard (or an
    // operator replayed it). Unlike inbound events, there is no message
    // payload here — the agent starts blind. Hand it everything the case
    // row knows so it can re-orient: the thread id (to wire
    // `conversation.fetch_thread` / `conversation.reply` without
    // guessing), the subject, and the context patches accumulated on
    // previous attempts (`case.update_context`).
    const parts: string[] = [];
    if (caseRow.threadId) {
      parts.push(`[Thread context: threadId=${caseRow.threadId}]`);
    }
    parts.push(
      `(system event: case.resumed — trigger: ${event.trigger})`,
      "A manager handed this case back to you and asked you to try again.",
    );
    if (caseSubject) {
      parts.push(`Subject: ${caseSubject}`);
    }
    if (Object.keys(caseRow.context).length > 0) {
      parts.push(
        `Context gathered on previous attempts:\n${JSON.stringify(caseRow.context, null, 2)}`,
      );
    }
    if (caseRow.threadId) {
      parts.push(
        "Start by calling conversation.fetch_thread with the threadId above to review the conversation so far, then complete the customer's request.",
      );
    }
    return [{ role: "user", content: parts.join("\n\n") }];
  }
  // Other events resume an in-flight case; for Phase 1 we don't have message
  // history, so we just signal what woke the case up.
  return [
    {
      role: "user",
      content: `(system event: ${event.type})`,
    },
  ];
};

// Derive a human-readable preview of the tool input for the approval
// email body. For `conversation.reply` / `conversation.ask_customer`,
// the bodyText is the right thing to show; for other gated tools we
// fall back to a JSON dump so the operator still sees what's being
// proposed. Capped so even a long reply stays inside a reasonable
// email height.
const PREVIEW_MAX = 600;
const derivePreview = (input: unknown): string => {
  if (input && typeof input === "object") {
    const r = input as Record<string, unknown>;
    if (typeof r["bodyText"] === "string") {
      return (r["bodyText"] as string).slice(0, PREVIEW_MAX);
    }
  }
  try {
    return JSON.stringify(input, null, 2).slice(0, PREVIEW_MAX);
  } catch {
    return String(input).slice(0, PREVIEW_MAX);
  }
};

const deriveSubject = (input: unknown): string | null => {
  if (input && typeof input === "object") {
    const r = input as Record<string, unknown>;
    if (typeof r["subject"] === "string") return r["subject"] as string;
  }
  return null;
};

/**
 * Money details stamped onto `tool.invoked` audit rows for refund.create
 * (audit L9). PermissionServiceLive sums these per case so the refund
 * threshold compares the cumulative refunded amount, not each call alone.
 */
/**
 * Stable execution key for the C2 dedup marker: the tool's input-derived
 * idempotency key when declared (refund: orderId+amount+currency; reply:
 * draftId) — so even a fresh LLM re-emission of the same action dedupes —
 * otherwise the caller-provided fallback (LLM callId / approval id).
 */
const executionKeyFor = (
  tool: AnyTool,
  input: unknown,
  fallback: string,
): string => {
  if (!tool.idempotencyKey) return fallback;
  try {
    return `${tool.name}:${tool.idempotencyKey(input as never)}`;
  } catch {
    return fallback;
  }
};

const refundAuditDetails = (
  toolName: string,
  input: unknown,
): Record<string, unknown> => {
  if (toolName !== "refund.create") return {};
  const parsed = parseRefundAmount(input);
  return parsed
    ? {
        amountMinorUnits: parsed.amountMinorUnits,
        currencyCode: parsed.currencyCode,
      }
    : {};
};

/**
 * Lock key for serializing a tick (audit L2): the case id when the event
 * references (or correlates to) an existing case; the thread key for a
 * first message whose case doesn't exist yet; null for events with no
 * case affinity (fresh ticket create, unsupported types).
 */
const deriveTickLockKey = (
  event: DomainEvent,
  cases: Context.Tag.Service<CaseRepository>,
): Effect.Effect<string | null> => {
  switch (event.type) {
    case "customer.replied":
    case "approval.approved":
    case "approval.rejected":
    case "supplier.updated":
    case "timer.expired":
    case "manual.takeover":
    case "case.resumed":
      return Effect.succeed(`case-tick:${event.caseId}`);
    case "message.received":
      return cases
        .findByThreadId(
          makeTenantId(event.tenantId),
          makeThreadId(event.threadId),
          parseThreadId(event.threadId)?.provider,
        )
        .pipe(
          Effect.map((row) =>
            row
              ? `case-tick:${row.id}`
              : `thread-tick:${event.tenantId}:${event.threadId}`,
          ),
          Effect.catchAll(() =>
            Effect.succeed(
              `thread-tick:${event.tenantId}:${event.threadId}`,
            ),
          ),
        );
    case "ticket.created":
    case "tracking.changed":
      return Effect.succeed(null);
  }
};

const riskFor = (tool: AnyTool): ApprovalRiskLevel => {
  switch (tool.risk) {
    case "read":
      return "low";
    case "communicate":
    case "write":
      return "medium";
    case "money":
      return "high";
  }
};

/**
 * Apply per-tenant per-agent overrides on top of the in-code AgentConfig:
 *   - `model` replaces `AgentConfig.model`.
 *   - `systemPrompt` is appended to `AgentConfig.promptTemplate` as extra
 *     instructions (brand voice / policy / tone) — the built-in prompt is kept
 *     so the agent's tool / handoff / approval scaffolding survives.
 *     `buildSystemPrompt` reads the patched `promptTemplate`, so the append
 *     flows through for the initial agent and any handoff.
 *   - `toolPermissions` overlays the tenant's per-tool "ask first" vs "auto"
 *     choices onto `permissionOverrides`. The tenant value wins over any in-code
 *     pin (e.g. an agent that statically pins a tool to `allow`), since the
 *     merchant's explicit choice is the more specific intent. `PermissionService`
 *     then reads the merged map unchanged.
 * Returns the same object reference when no override applies, so the hot path
 * doesn't allocate. Pure + exported so it can be unit-tested without booting the
 * runtime layer. Future fields (temperature, …) plug in here.
 */
export const applyOverride = (
  agent: AgentConfig,
  overrideMap: ReadonlyMap<AgentConfig["id"], AgentOverride>,
): AgentConfig => {
  const o = overrideMap.get(agent.id);
  if (!o) return agent;
  let next = agent;
  if (o.model && o.model !== agent.model) {
    next = { ...next, model: o.model };
  }
  const extra = o.systemPrompt?.trim();
  if (extra) {
    next = {
      ...next,
      promptTemplate: `${agent.promptTemplate}\n\n${extra}`,
    };
  }
  if (o.toolPermissions && Object.keys(o.toolPermissions).length > 0) {
    next = {
      ...next,
      permissionOverrides: {
        ...next.permissionOverrides,
        ...o.toolPermissions,
      },
    };
  }
  return next;
};

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

export const AgentRuntimeDefault = Layer.effect(
  AgentRuntime,
  Effect.gen(function* () {
    const cases = yield* CaseRepository;
    const audit = yield* AuditLogService;
    const registry = yield* AgentRegistry;
    const tools = yield* ToolRegistry;
    const perms = yield* PermissionService;
    const approvals = yield* ApprovalService;
    const llm = yield* LLMService;
    const shopify = yield* ShopifyService;
    const tx = yield* TransactionRunner;
    const mail = yield* PlatformMailService;
    const linkConfig = yield* ApprovalLinkConfig;
    const overrides = yield* TenantAgentOverridesService;
    const tenantRepo = yield* TenantRepository;
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
    // Optional idempotency stores (audit C2/C3) — present in the worker,
    // absent in lean test layers (which then skip the dedup, as before).
    const maybeProcessed = yield* Effect.serviceOption(ProcessedMessageStore);
    const maybeExecutions = yield* Effect.serviceOption(ToolExecutionStore);

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
              );
              if (existing) {
                row = existing;
              } else {
                row = yield* cases.create({
                  tenantId: makeTenantId(lookup.tenantId),
                  channel: lookup.channel,
                  currentAgentId: makeAgentId("support-triage"),
                  subject: lookup.subject,
                  threadId: makeThreadId(lookup.threadId),
                });
                wasCreated = true;
              }
            }
            yield* audit.record({
              tenantId: row.tenantId,
              caseId: row.id,
              actor: { type: "system", id: "runtime" },
              action: "event.received",
              details: { eventType: event.type },
            });
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
          tx.run(
            Effect.gen(function* () {
              const updated = yield* cases.transitionStatus(
                caseId,
                "human_takeover",
                { reason, tenantId: working.tenantId },
              );
              yield* audit.record({
                tenantId: updated.tenantId,
                caseId: updated.id,
                actor: { type: "system", id: "agent-runtime" },
                action: "case.escalated_to_human",
                details: { reason, ...details },
              });
              return updated;
            }),
          );

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
        if (event.type === "approval.approved") {
          const approval = yield* approvals
            .getById(event.approvalId, working.tenantId)
            .pipe(
            Effect.catchTag("ApprovalNotFound", () =>
              Effect.succeed(null),
            ),
            Effect.catchAll(() => Effect.succeed(null)),
          );
          if (!approval) {
            return {
              type: "Failed",
              reason: `approval ${event.approvalId} not found`,
              retryable: false,
            } as const;
          }
          // Duplicate-delivery guard (audit C2): pg-boss is at-least-once.
          // A re-delivered `approval.approved` for a case that already ran
          // to completion must NOT execute the gated tool a second time —
          // that's a double refund / double customer email.
          if (working.status === "resolved") {
            yield* tx.run(
              audit.record({
                tenantId: working.tenantId,
                caseId: working.id,
                actor: { type: "system", id: "runtime" },
                action: "approval.duplicate_delivery_skipped",
                details: { approvalId: approval.id },
              }),
            );
            return { type: "Completed" } as const;
          }
          // A row that was rejected / cancelled / expired out-of-band must
          // never execute, whatever the event says.
          if (
            approval.status === "rejected" ||
            approval.status === "cancelled" ||
            approval.status === "expired"
          ) {
            return {
              type: "Failed",
              reason: `approval ${approval.id} is ${approval.status}`,
              retryable: false,
            } as const;
          }
          // Expiry (audit L7): an undecided row past its expiry must not
          // run a stale draft. (Rows already flipped to `approved` were
          // validated at decision time; queue latency after a timely
          // decision is fine.)
          if (
            approval.status === "pending" &&
            approval.expiresAt.getTime() < Date.now()
          ) {
            yield* escalateToHuman(working.id, "approval_expired", {
              approvalId: approval.id,
              expiresAt: approval.expiresAt.toISOString(),
            });
            return {
              type: "HumanTakeoverRequired",
              reason: "approval_expired",
            } as const;
          }
          const toolToRun = yield* tools.tryGet(approval.tool);
          if (!toolToRun) {
            return {
              type: "Failed",
              reason: `tool ${approval.tool} not in registry`,
              retryable: false,
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
          const resumeAgent = yield* registry
            .resolve(approval.agentId)
            .pipe(Effect.option);
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
          const executionKey = executionKeyFor(toolToRun, toolInput, callId);
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
            agentId: approval.agentId,
            callId,
            attemptNumber: 1,
          };
          // The external side effect runs OUTSIDE the SQL tx (audit D6);
          // the audit row + execution marker then commit together. A
          // declared tool timeout is honored here too (audit L15).
          const rawResumeEffect = toolToRun.execute(
            toolInput,
            ctx,
          ) as unknown as Effect.Effect<unknown, unknown, never>;
          const resumeEffect = toolToRun.timeout
            ? rawResumeEffect.pipe(Effect.timeout(toolToRun.timeout))
            : rawResumeEffect;
          let exec: { readonly _tag: "Right" | "Left"; readonly right?: unknown; readonly left?: unknown };
          if (priorMarker) {
            // Already executed successfully in a prior delivery — skip
            // the side effect, finish the resolve step below.
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
                  },
                });
                // Marker shares the tx with the audit row (audit C2):
                // both commit or neither does.
                if (Option.isSome(maybeExecutions)) {
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
            yield* escalateToHuman(working.id, "approved_tool_failed", {
              approvalId: approval.id,
              tool: approval.tool,
            });
            return {
              type: "HumanTakeoverRequired",
              reason: `approved tool ${approval.tool} failed`,
            } as const;
          }
          working = yield* tx.run(
            Effect.gen(function* () {
              const resolved = yield* cases.transitionStatus(
                working.id,
                "resolved",
                { reason: `approved tool ${approval.tool}` },
              );
              yield* audit.record({
                tenantId: resolved.tenantId,
                caseId: resolved.id,
                actor: { type: "user", id: event.managerId },
                action: "case.resolved",
                details: {
                  viaApprovalId: approval.id,
                  tool: approval.tool,
                },
              });
              return resolved;
            }),
          );
          return { type: "Completed" } as const;
        }

        if (event.type === "approval.rejected") {
          working = yield* tx.run(
            Effect.gen(function* () {
              const updated = yield* cases.transitionStatus(
                working.id,
                "human_takeover",
                { reason: "approval rejected" },
              );
              yield* audit.record({
                tenantId: updated.tenantId,
                caseId: updated.id,
                actor: { type: "user", id: event.managerId },
                action: "case.escalated_to_human",
                details: {
                  approvalId: event.approvalId,
                  reason: event.reason ?? null,
                },
              });
              return updated;
            }),
          );
          return {
            type: "HumanTakeoverRequired",
            reason: "approval rejected",
          } as const;
        }

        // 2a. Customer identification — only on a freshly-created case
        // bound to an inbound message. Best-effort: the tick proceeds
        // even if Shopify is down / not configured / has no match for
        // this email. Persists `customerEmail` (always when we have one)
        // and `shopifyCustomerId` (only on a positive match) into the
        // case context. Specialists like refund-review can read these
        // without firing their own searchByEmail per tick.
        if (wasCreated && event.type === "message.received") {
          const email = event.payload.from.email;
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
        let agent: AgentConfig = applyOverride(
          yield* registry.resolve(working.currentAgentId),
          overrideMap,
        );
        const messages: ChatMessage[] = buildInitialMessages(event, {
          subject: working.subject,
          threadId: working.threadId,
          context: working.context,
        });
        let current = working;

        for (let turn = 0; turn < agent.maxTurnsPerTick; turn++) {
          const schemas = yield* tools.schemasFor(agent.tools);
          // BYOK: surface missing/revoked per-tenant LLM credentials as
          // human_takeover instead of a generic Failed. Other LLM errors
          // continue to bubble up to the outer catchAllCause.
          const decisionEither = yield* llm
            .runToolCalling({
              tenantId: current.tenantId,
              model: agent.model,
              system: buildSystemPrompt(agent, tenantSettings, knowledgeTitles),
              messages,
              tools: schemas,
              ...(agent.temperature !== undefined
                ? { temperature: agent.temperature }
                : {}),
            })
            .pipe(Effect.either);
          if (decisionEither._tag === "Left") {
            const err = decisionEither.left;
            if (
              err._tag === "LLMCredentialMissing" ||
              err._tag === "LLMCredentialRevoked"
            ) {
              const reason =
                err._tag === "LLMCredentialMissing"
                  ? "llm_credential_missing"
                  : "llm_credential_revoked";
              current = yield* tx.run(
                Effect.gen(function* () {
                  const updated = yield* cases.transitionStatus(
                    current.id,
                    "human_takeover",
                    { reason },
                  );
                  yield* audit.record({
                    tenantId: updated.tenantId,
                    caseId: updated.id,
                    actor: { type: "system", id: "agent-runtime" },
                    action: "case.escalated_to_human",
                    details: {
                      reason,
                      ...(err._tag === "LLMCredentialRevoked"
                        ? { provider: err.provider }
                        : {}),
                    },
                  });
                  return updated;
                }),
              );
              return {
                type: "HumanTakeoverRequired",
                reason,
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
              // Wrap the final transition + a "case.resolved" audit in one
              // tx — keeps the resolved status and its audit row atomically
              // consistent (master-plan §4).
              const resolveExit = yield* tx
                .run(
                  Effect.gen(function* () {
                    const row = yield* cases.transitionStatus(
                      current.id,
                      "resolved",
                      { reason: "runtime: final_message" },
                    );
                    yield* audit.record({
                      tenantId: row.tenantId,
                      caseId: row.id,
                      actor: { type: "agent", id: agent.id },
                      action: "case.resolved",
                      details: { turn, finalMessage: decision.text },
                    });
                    return row;
                  }),
                )
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
            }
            return { type: "Completed" } as const;
          }

          if (decision.type === "handoff") {
            // Same allowlist as the `agent.handoff` pseudo-tool below
            // (audit L13): a decision-level handoff to an agent outside
            // `agent.handoffs` is blocked, audited, and the loop continues
            // with the current agent.
            const allowed = agent.handoffs.some(
              (h) => (h as string) === (decision.targetAgent as string),
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
            const nextAgent = applyOverride(
              yield* registry.resolve(decision.targetAgent),
              overrideMap,
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
            const allowed =
              target !== null &&
              agent.handoffs.some((h) => (h as string) === target);

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
                  allowed: agent.handoffs,
                },
              });
              continue;
            }

            const targetAgentId = makeAgentId(target as string);
            const targetAgent = applyOverride(
              yield* registry.resolve(targetAgentId),
              overrideMap,
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
            continue;
          }

          const tool = yield* tools.tryGet(decision.tool);
          if (!tool) {
            messages.push({
              role: "tool",
              toolCallId: decision.callId,
              toolName: decision.tool,
              content: { error: "unknown_tool" },
            });
            continue;
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
            continue;
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
              continue;
            }
          }

          const permission = yield* perms.check({
            tenantId: current.tenantId,
            agent,
            tool,
            payload: callInput,
            caseId: current.id,
          });

          if (permission === "deny") {
            messages.push({
              role: "tool",
              toolCallId: decision.callId,
              toolName: tool.name,
              content: { error: "denied_by_policy" },
            });
            continue;
          }

          if (permission === "ask") {
            // Approval row + park transition + audit row in ONE tx (audit
            // L6) — a crash between them previously left a pending approval
            // on an un-parked case, so the agent could keep acting and a
            // second approval could be created. master-plan §4: the audit
            // write shares the transaction with the state change.
            const parked = yield* tx.run(
              Effect.gen(function* () {
                const approval = yield* approvals.create({
                  tenantId: current.tenantId,
                  caseId: current.id,
                  agentId: agent.id,
                  tool: tool.name,
                  proposedInput: callInput,
                  reasoning: decision.reasoning ?? "",
                  riskLevel: riskFor(tool),
                  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
                });
                const row = yield* cases.transitionStatus(
                  current.id,
                  "waiting_for_approval",
                  { reason: `tool ${tool.name} pending approval` },
                );
                yield* audit.record({
                  tenantId: row.tenantId,
                  caseId: row.id,
                  actor: { type: "agent", id: agent.id },
                  action: "case.waiting_for_approval",
                  details: {
                    approvalId: approval.id,
                    tool: tool.name,
                    turn,
                  },
                });
                return { approval, row };
              }),
            );
            const approval = parked.approval;
            current = parked.row;

            // Fire the approval-link email. Best-effort: a Resend outage,
            // a tenant without `notificationEmail` configured, or any other
            // mail failure must NOT block the case. The approval row is
            // the source of truth and the dashboard (when it lands) will
            // pick it up regardless. Each URL carries its OWN signed token
            // with the action bound into the HMAC (audit S3) — holding a
            // reject link must not allow approving by editing the path.
            const approveToken = signApprovalToken({
              approvalId: approval.id,
              action: "approve",
              secret: linkConfig.signingKey,
              ttlMs: linkConfig.ttlMs,
            });
            const rejectToken = signApprovalToken({
              approvalId: approval.id,
              action: "reject",
              secret: linkConfig.signingKey,
              ttlMs: linkConfig.ttlMs,
            });
            const approveUrl = `${linkConfig.baseUrl}/approvals/${approval.id}/approve?token=${encodeURIComponent(approveToken)}`;
            const rejectUrl = `${linkConfig.baseUrl}/approvals/${approval.id}/reject?token=${encodeURIComponent(rejectToken)}`;
            const draftPreview = derivePreview(callInput);
            const draftSubject = deriveSubject(callInput);
            yield* mail
              .sendApprovalLink({
                tenantId: current.tenantId,
                approvalId: approval.id,
                draftSubject,
                draftPreview,
                toolName: tool.name,
                approveUrl,
                rejectUrl,
              })
              .pipe(Effect.either);

            return {
              type: "PausedWaitingForApproval",
              approvalId: approval.id,
            } as const;
          }

          // allow → execute. The tool's external side effect runs OUTSIDE
          // the SQL transaction (audit D6): holding a pool connection across
          // provider HTTP latency starved the pool, and a commit failure
          // AFTER an email was actually sent rolled back the audit record of
          // a send that really happened. The audit row + execution marker
          // then commit together in one tx (master-plan §4: the audit write
          // shares the transaction with the state change — the external
          // effect itself was never transactional). Tools that mutate case
          // state (case.update_status) keep their own atomic writes.
          const ctx: ToolContext = {
            tenantId: current.tenantId,
            caseId: current.id,
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
          // Honor the tool's declared timeout (audit L15) — a hung connector
          // call must not pin the tick (and previously its DB tx) until the
          // HTTP client's own timeout while the job clock runs toward
          // redelivery.
          const toolEffect = tool.timeout
            ? rawToolEffect.pipe(Effect.timeout(tool.timeout))
            : rawToolEffect;
          const result = yield* toolEffect.pipe(Effect.either);
          const exec = yield* tx.run(
            Effect.gen(function* () {
              const outputDetails =
                tool.name === "refund.recommend" && result._tag === "Right"
                  ? { output: result.right }
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
                },
              });
              // C2 marker — same tx as the audit row; only meaningful
              // for tools with externally-visible effects.
              if (
                tool.sideEffectClass !== "none" &&
                Option.isSome(maybeExecutions)
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
            if (tool.name === "conversation.ask_customer") {
              current = yield* tx.run(
                Effect.gen(function* () {
                  const updated = yield* cases.transitionStatus(
                    current.id,
                    "waiting_for_customer",
                    { reason: "conversation.ask_customer" },
                  );
                  yield* audit.record({
                    tenantId: updated.tenantId,
                    caseId: updated.id,
                    actor: { type: "agent", id: agent.id },
                    action: "case.waiting_for_customer",
                    details: { tool: tool.name, callId: decision.callId },
                  });
                  return updated;
                }),
              );
              return { type: "PausedWaitingForCustomer" } as const;
            }
            messages.push({
              role: "tool",
              toolCallId: decision.callId,
              toolName: tool.name,
              content: exec.right,
            });
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
          }
        }

        // Turn budget exhausted — park the case durably (audit L4). Guard
        // against clobbering a terminal status a tool legitimately set on
        // the final turn.
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
