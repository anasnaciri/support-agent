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
  type InboundMessage,
  type LLMDecision,
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
import {
  REPLY_DELIVERY_FAILED_FLAG,
  ReplyDeliveryService,
  isReplyDeliverySendFailure,
} from "./reply-delivery.js";

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
      readonly mailbox: string | undefined;
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
        mailbox: event.payload.mailbox,
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

  const body =
    headers.length === 0
      ? agent.promptTemplate
      : `${agent.promptTemplate}\n\n${headers.join("\n\n")}`;
  // Prefix the untrusted-content preamble so the model knows that fenced
  // customer text and every tool result are data, not instructions
  // (prompt-injection mitigation). buildInitialMessages / tool-result
  // serialization wrap the matching spans in the sentinels this names.
  return `${UNTRUSTED_PREAMBLE}\n\n${body}`;
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

/**
 * Trusted directive injected on resume of a `where_is_order` case that was
 * flagged as an order/customer mismatch. Tells the specialist either to run the
 * identity challenge (ask the customer to confirm the order's email before
 * disclosing) or, once the runtime has verified that confirmation, to go ahead
 * and send the status. Carries the order id + reply wiring so the agent can act
 * without the prior tick's tool results. Returns "" for every case that isn't
 * mid-verification, so normal flows are untouched. Stays OUTSIDE the untrusted
 * fence — it's runtime-authored, not customer text.
 */
const orderIdentityDirective = (
  context: Record<string, unknown>,
  threadId: ThreadId | null,
): string => {
  if (context["classification"] !== "where_is_order") return "";
  const flags = Array.isArray(context["riskFlags"])
    ? (context["riskFlags"] as unknown[]).filter(
        (f): f is string => typeof f === "string",
      )
    : [];
  if (!flags.includes("order_customer_mismatch")) return "";
  const orderRef =
    typeof context["identifiedOrderId"] === "string"
      ? `order ${context["identifiedOrderId"]}`
      : "the order";
  const wiring = [
    threadId ? `threadId=${threadId}` : null,
    typeof context["customerEmail"] === "string"
      ? `reply to=${context["customerEmail"]}`
      : null,
  ]
    .filter(Boolean)
    .join(", ");
  const wiringNote = wiring ? ` (${wiring})` : "";
  if (context["identityVerified"] === true) {
    return `[Identity check PASSED${wiringNote}: the customer confirmed the email used to place ${orderRef} and the system verified it. Look up the order and send the status reply now.]`;
  }
  return `[Identity check REQUIRED${wiringNote}: this customer is writing from a different email than the one ${orderRef} was placed under. Do NOT share any order details yet. Ask them to confirm the email used to place the order via conversation.ask_customer; only after they reply with the matching email may you share the status. If the email they give does not match the order, do not disclose — apologise and ask them to write in from the email used at checkout.]`;
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
        // Subject + body are both customer-authored — fence them as untrusted.
        content: wrapUntrusted(`Subject: ${subject}\n\n${event.payload.body}`),
      },
    ];
  }
  if (event.type === "customer.replied") {
    const directive = orderIdentityDirective(caseRow.context, caseRow.threadId);
    const body = wrapUntrusted(event.payload.bodyText ?? "(empty reply)");
    return [
      buildUserMessageFromInbound(
        directive ? `${directive}\n\n${body}` : body,
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
    // The runtime-built header (threadId / from) is trusted and stays OUTSIDE
    // the fence so the agent can still wire conversation.* tools from it. The
    // customer-authored subject + body go INSIDE the untrusted fence.
    const header = `[Thread context: threadId=${event.threadId}, from=${event.payload.from.email}]`;
    const directive = orderIdentityDirective(caseRow.context, caseRow.threadId);
    const customerBlock = wrapUntrusted(
      `Subject: ${subject}\n\n${event.payload.bodyText}`,
    );
    const text = directive
      ? `${header}\n\n${directive}\n\n${customerBlock}`
      : `${header}\n\n${customerBlock}`;
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
      // The context blob holds agent-derived fields plus free-text the LLM
      // wrote on prior turns (notes, classification). Fence it so a prior
      // turn's injected text can't act as instructions on resume.
      parts.push(
        `Context gathered on previous attempts:\n${wrapUntrusted(
          JSON.stringify(caseRow.context, null, 2),
        )}`,
      );
    }
    if (caseRow.threadId) {
      parts.push(
        "Start by calling conversation.fetch_thread with the threadId above to review the conversation so far, then complete the customer's request.",
      );
    }
    return [{ role: "user", content: parts.join("\n\n") }];
  }
  if (event.type === "supplier.updated") {
    // The supplier responded on a parked case. Re-enter the agent loop so it
    // drafts a CUSTOMER-FACING reply. The supplier is a third party, so fence
    // their note as untrusted and instruct the agent to REWRITE it — never
    // quote it verbatim or reveal that the update came from a supplier. The
    // trusted thread header stays OUTSIDE the fence so the agent can still wire
    // conversation.* tools.
    const parts: string[] = [];
    // The customer email is runtime-stamped on the case context (trusted), so
    // the agent can address conversation.reply without a thread fetch.
    const customerEmail =
      typeof caseRow.context["customerEmail"] === "string"
        ? (caseRow.context["customerEmail"] as string)
        : null;
    if (caseRow.threadId) {
      parts.push(
        customerEmail
          ? `[Thread context: threadId=${caseRow.threadId}, customer=${customerEmail}]`
          : `[Thread context: threadId=${caseRow.threadId}]`,
      );
    }
    parts.push(
      "(system event: supplier.updated)",
      "The supplier responded on this case. Draft a reply to the CUSTOMER that resolves their request, in your own words — do NOT quote the supplier's note verbatim, and never reveal that the update came from a supplier or warehouse.",
    );
    if (caseSubject) {
      parts.push(`Subject: ${caseSubject}`);
    }
    const proposed = event.payload.proposedResolution;
    parts.push(
      `Supplier update (untrusted — rewrite for the customer):\n${wrapUntrusted(
        `Note: ${event.payload.note}${
          proposed ? `\n\nProposed resolution: ${proposed}` : ""
        }`,
      )}`,
    );
    if (caseRow.threadId) {
      parts.push(
        "Send the customer reply with conversation.reply, using the threadId and customer address from the header above.",
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
  scope?: string,
): string => {
  const base = (() => {
    if (!tool.idempotencyKey) return fallback;
    try {
      return `${tool.name}:${tool.idempotencyKey(input as never)}`;
    } catch {
      return fallback;
    }
  })();
  return scope ? `${scope}:${base}` : base;
};

/**
 * Per-delivery discriminator for the C2 execution-marker key. The marker
 * exists only to stop a REDELIVERED job (the same event replayed from turn
 * 0 after a crash) from re-running a side-effecting tool. Because the
 * marker is stored case-scoped and never expires, an UNscoped key also
 * (wrongly) deduped a *different* delivery that happened to reuse a tool's
 * idempotency key — e.g. a second customer reply on the same thread whose
 * agent re-drafts `conversation.reply` with the same `draftId`, or a fresh
 * approval execution after an earlier approved send on the same case. That
 * silently swallowed the reply.
 *
 * Scoping the key by the delivery keeps the redelivery guarantee (a
 * redelivered job carries the same discriminator) while letting a genuinely
 * new delivery re-invoke the tool. Inbound messages key by their provider
 * message id — stable across redeliveries, distinct per new message, and
 * already the unit `ProcessedMessageStore` claims on; resuming events key by
 * their own correlation id. (`supplier.updated` / `case.resumed` /
 * `manual.takeover` fall back to the case id: the event carries no
 * per-delivery id, so two of the same on one case could still cross-dedup —
 * rare, and a follow-up.)
 */
const deliveryScopeFor = (event: DomainEvent): string => {
  switch (event.type) {
    case "message.received":
    case "customer.replied":
      return `msg:${event.payload.messageId}`;
    case "approval.approved":
    case "approval.rejected":
      return `appr:${event.approvalId}`;
    case "timer.expired":
      return `timer:${event.timerId}`;
    case "ticket.created":
      return `ticket:${event.source}`;
    case "tracking.changed":
      return `track:${event.orderId}`;
    case "supplier.updated":
    case "manual.takeover":
    case "case.resumed":
      return `case:${event.caseId}`;
  }
};

/**
 * RFC Message-IDs an inbound reply points at — its In-Reply-To plus every
 * entry in its References chain. These are the ids of EARLIER messages in the
 * thread (a prior inbound, or our own outbound reply), which the runtime looks
 * up in the message-id index to correlate the reply to its existing case when
 * the derived thread-id doesn't exact-match (clients reorder/truncate the
 * chain, so `references[0]` is not a reliable thread root). The message's own
 * id is deliberately excluded — it's new and can't match an existing case.
 * Deduped, brackets-trimmed, empties dropped. Exported for unit testing.
 */
export const inboundReplyCandidateIds = (
  payload: InboundMessage,
): ReadonlyArray<string> => {
  const trim = (s: string): string => s.replace(/^<+/, "").replace(/>+$/, "").trim();
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string | null | undefined): void => {
    if (!raw) return;
    const id = trim(raw);
    if (id.length === 0 || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  add(payload.inReplyTo);
  for (const ref of payload.references ?? []) add(ref);
  return out;
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
 * A concise, length-capped failure label for a FAILED `tool.invoked` audit row.
 * Without this the audit only records `{ok:false}` — a real delivery failure
 * (`ConversationSendFailed`, a provider tag, …) leaves no readable trace in prod
 * (the reason only ever hit stdout). Prefers the `ToolOutputInvalid` issues (the
 * conversation tools put the underlying `ConversationError` `_tag` there), then a
 * raw error `_tag`, then a stringified fallback. Each issue is truncated at the
 * first `:` so a recipient/mailbox suffix (e.g. an email in
 * `recipient_not_in_thread:<addr>`) can never leak into the audit — we keep the
 * diagnostic KEY, not the PII value.
 */
export const toolFailureAuditDetail = (
  left: unknown,
): Record<string, string> => {
  if (left === null || left === undefined) return {};
  if (typeof left !== "object") {
    const s = String(left).trim();
    return s ? { error: s.slice(0, 200) } : {};
  }
  const e = left as {
    readonly _tag?: unknown;
    readonly issues?: unknown;
    readonly code?: unknown;
    readonly message?: unknown;
    readonly name?: unknown;
  };
  if (Array.isArray(e.issues)) {
    const joined = e.issues
      .filter((i): i is string => typeof i === "string")
      .map((i) => i.split(":")[0] ?? i)
      .join(",")
      .slice(0, 200);
    if (joined) return { error: joined };
  }
  if (typeof e._tag === "string" && e._tag) return { error: e._tag };
  // Non-tagged failures (a bare Error from the connector, an SMTP error): keep a
  // readable reason. Prefer a short error CODE (e.g. nodemailer `EAUTH`,
  // `ETIMEDOUT`) over the free-text message, then the message, then the class.
  if (typeof e.code === "string" && e.code) return { error: e.code.slice(0, 200) };
  if (typeof e.message === "string" && e.message) {
    return { error: e.message.slice(0, 200) };
  }
  if (typeof e.name === "string" && e.name) return { error: e.name.slice(0, 200) };
  return {};
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
          event.payload.mailbox,
        )
        .pipe(
          Effect.map((row) =>
            row
              ? `case-tick:${row.id}`
              : `thread-tick:${event.tenantId}:${event.payload.mailbox ?? "legacy"}:${event.threadId}`,
          ),
          Effect.catchAll(() =>
            Effect.succeed(
              `thread-tick:${event.tenantId}:${event.payload.mailbox ?? "legacy"}:${event.threadId}`,
            ),
          ),
        );
    case "ticket.created":
    case "tracking.changed":
      return Effect.succeed(null);
  }
};

/**
 * Prompt-injection mitigation (refund scope): warn when a proposed
 * `refund.create` targets an order whose customer email doesn't match the
 * case's bound customer. A prompt-injected agent could be steered to refund an
 * unrelated order; the order's customer is authoritative (Shopify data) and
 * the case's `customerEmail` is stamped by the runtime from the inbound
 * sender (not the LLM), so a divergence is a strong "this refund may be aimed
 * at the wrong order" signal for the human approver.
 *
 * Returns the risk-flag string to stamp, or null when there's nothing to warn
 * about: not a refund, the case customer is unknown, the order wasn't looked
 * up this tick, the looked-up order has no email, or the emails match. Fails
 * OPEN (null) on every missing input so it never blocks a legitimate refund —
 * it only adds a warning when it has positive evidence of a mismatch.
 *
 * Pure + exported so the decision logic is unit-tested without the runtime.
 */
export const refundCustomerMismatchFlag = (
  input: unknown,
  caseContext: Record<string, unknown>,
  seenOrderEmails: ReadonlyMap<string, string | null>,
): string | null => {
  const caseEmail = caseContext["customerEmail"];
  if (typeof caseEmail !== "string" || caseEmail.trim() === "") return null;
  if (!input || typeof input !== "object") return null;
  const orderId = (input as Record<string, unknown>)["orderId"];
  if (typeof orderId !== "string") return null;
  if (!seenOrderEmails.has(orderId)) return null;
  const orderEmail = seenOrderEmails.get(orderId);
  if (typeof orderEmail !== "string" || orderEmail.trim() === "") return null;
  if (orderEmail.trim().toLowerCase() === caseEmail.trim().toLowerCase()) {
    return null;
  }
  return "refund_customer_mismatch";
};

/** Trim + lowercase an email for comparison, or null if it isn't a usable string. */
const normalizeEmailForMatch = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return v === "" ? null : v;
};

/** Read `context.riskFlags` as a string array (the runtime's fraud/guard chips). */
const readRiskFlags = (context: Record<string, unknown>): string[] =>
  Array.isArray(context["riskFlags"])
    ? (context["riskFlags"] as unknown[]).filter(
        (f): f is string => typeof f === "string",
      )
    : [];

/**
 * Order-status identity guard (the `where_is_order` flow). Returns
 * `"order_customer_mismatch"` when the looked-up order's customer email differs
 * from the case's bound (runtime-stamped) customer, else null. The sibling of
 * {@link refundCustomerMismatchFlag} for read-disclosure rather than refunds:
 * replying with the order's status would leak another customer's order details.
 *
 * Fails OPEN (null) on any missing input — an unknown order email or an
 * unidentified case customer never raises a false alarm. Pure + exported so the
 * decision is unit-tested without the runtime.
 */
export const orderCustomerMismatchFlag = (
  orderEmail: unknown,
  caseContext: Record<string, unknown>,
): string | null => {
  const order = normalizeEmailForMatch(orderEmail);
  const caseEmail = normalizeEmailForMatch(caseContext["customerEmail"]);
  if (!order || !caseEmail) return null;
  return order === caseEmail ? null : "order_customer_mismatch";
};

/**
 * Deterministic identity check for the order-status verification challenge:
 * does the customer's reply state the email the order was placed under? Pulls
 * email-shaped tokens out of the (untrusted) reply text and matches any against
 * the order email, normalized. Run by the RUNTIME — never the model — so a
 * prompt-injected reply body can't talk its way to a pass. Fails closed (false)
 * on missing inputs.
 */
export const replyProvesOrderIdentity = (
  replyText: unknown,
  orderEmail: unknown,
): boolean => {
  const target = normalizeEmailForMatch(orderEmail);
  if (!target || typeof replyText !== "string") return false;
  const tokens = replyText.toLowerCase().match(/[^\s<>()"']+@[^\s<>()"']+/g);
  if (!tokens) return false;
  return tokens.some((t) => t.replace(/[.,;:!?]+$/, "") === target);
};

/**
 * Backstop that survives the tenant's auto/ask toggle: should a
 * `conversation.reply` on this case be forced to human approval no matter what
 * the per-agent permission resolves to? True when the case is a
 * `where_is_order` case flagged as an order/customer mismatch whose requester
 * has NOT verified their identity — i.e. sending the reply would disclose a
 * different customer's order. Once {@link replyProvesOrderIdentity} has stamped
 * `identityVerified`, the gate lifts and the reply flows on its normal
 * permission. Pure + exported for unit coverage.
 */
export const shouldForceReplyApproval = (
  toolName: string,
  context: Record<string, unknown>,
): boolean => {
  if (toolName !== "conversation.reply") return false;
  if (context["classification"] !== "where_is_order") return false;
  if (context["identityVerified"] === true) return false;
  return readRiskFlags(context).includes("order_customer_mismatch");
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
    // Optional merchant push channel (Telegram, …) — present when the
    // deployment wires one; absent in lean test layers. Strictly
    // best-effort: a ping must never change a tick's outcome.
    const maybeNotifications = yield* Effect.serviceOption(
      MerchantNotificationService,
    );
    // Optional durable outbox for FAILED customer-reply sends — present in the
    // worker (ReplyDeliveryServiceLive). Absent in lean test layers, in which
    // case the case is still flagged + parked, just not durably re-sent.
    const maybeReplyDelivery = yield* Effect.serviceOption(ReplyDeliveryService);

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
            const updated = yield* tx.run(
              Effect.gen(function* () {
                const row = yield* cases.transitionStatus(
                  caseId,
                  "human_takeover",
                  { reason, tenantId: working.tenantId },
                );
                yield* audit.record({
                  tenantId: row.tenantId,
                  caseId: row.id,
                  actor: { type: "system", id: "agent-runtime" },
                  action: "case.escalated_to_human",
                  details: { reason, ...details },
                });
                return row;
              }),
            );
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

        // A customer-reply (`conversation.reply` / `ask_customer`) send FAILED.
        // Don't lose it and don't let the case resolve as if it went out:
        //   1. persist the verbatim draft into the reply-delivery outbox so the
        //      worker sweep + the dashboard "Retry sending email" button can
        //      re-send the SAME email (no LLM re-run);
        //   2. stamp the `reply_delivery_failed` risk flag so the dashboard
        //      shows it + the merchant knows the customer wasn't reached;
        //   3. park the case in `human_takeover` (NEEDS ATTENTION, never
        //      resolved) — a successful retry later auto-resolves it.
        // Steps 1+2 are best-effort; the park (audit L4) always happens.
        const parkForReplyDeliveryFailure = (
          caseRow: typeof working,
          agentId: string,
          toolName: string,
          draftInput: unknown,
          errLeft: unknown,
        ) =>
          Effect.gen(function* () {
            const issues = (errLeft as { readonly issues?: unknown }).issues;
            const errTag = (errLeft as { readonly _tag?: unknown })._tag;
            const errorLabel =
              Array.isArray(issues) && issues.length > 0
                ? issues.filter((i) => typeof i === "string").join(",")
                : typeof errTag === "string"
                  ? errTag
                  : "ConversationSendFailed";
            const rawDraftId = (draftInput as { readonly draftId?: unknown })
              .draftId;
            const draftId =
              typeof rawDraftId === "string" && rawDraftId.length > 0
                ? rawDraftId
                : `${caseRow.id}:${toolName}`;
            if (Option.isSome(maybeReplyDelivery)) {
              yield* maybeReplyDelivery.value
                .enqueue({
                  tenantId: caseRow.tenantId,
                  caseId: caseRow.id,
                  agentId,
                  tool: toolName,
                  mailbox: caseRow.mailbox ?? null,
                  draftId,
                  draft: draftInput,
                  error: errorLabel,
                })
                .pipe(Effect.catchAll(() => Effect.void));
            }
            const existingFlags = readRiskFlags(caseRow.context);
            if (!existingFlags.includes(REPLY_DELIVERY_FAILED_FLAG)) {
              yield* cases
                .update(caseRow.id, {
                  context: {
                    ...caseRow.context,
                    riskFlags: [...existingFlags, REPLY_DELIVERY_FAILED_FLAG],
                  } as never,
                })
                .pipe(Effect.catchAll(() => Effect.succeed(caseRow)));
            }
            yield* escalateToHuman(caseRow.id, REPLY_DELIVERY_FAILED_FLAG, {
              tool: toolName,
              error: errorLabel,
            });
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
                    ...(result._tag === "Left"
                      ? toolFailureAuditDetail(result.left)
                      : {}),
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

        // 2a-bis. Order-status identity verification — when a customer replies
        // to a case we flagged as an order/customer mismatch, check (in the
        // runtime, never the model) whether their reply states the email the
        // order was placed under. A match clears the disclosure gate so the
        // status reply can proceed automatically; a miss leaves the case gated
        // (the reply still routes to human approval via the backstop at the
        // permission check). Keyed off `pendingOrderEmail`, persisted at
        // detection time. Best-effort: a write failure simply leaves the gate
        // up. The model cannot set `identityVerified` — it's stamped here and
        // absent from the case.update_context allowlist — so a prompt-injected
        // reply body can't fake a pass.
        if (
          (event.type === "message.received" ||
            event.type === "customer.replied") &&
          working.context["identityVerified"] !== true &&
          readRiskFlags(working.context).includes("order_customer_mismatch") &&
          replyProvesOrderIdentity(
            event.payload.bodyText,
            working.context["pendingOrderEmail"],
          )
        ) {
          working = yield* cases
            .update(working.id, {
              context: {
                ...working.context,
                identityVerified: true,
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
          working = yield* tx.run(
            Effect.gen(function* () {
              const row = yield* cases.transitionStatus(
                working.id,
                "in_progress",
                { reason: `reopened by ${event.type}` },
              );
              yield* audit.record({
                tenantId: row.tenantId,
                caseId: row.id,
                actor: { type: "system", id: "runtime" },
                action: "case.reopened",
                details: { eventType: event.type },
              });
              return row;
            }),
          );
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
        // Order id/name → customer email, populated as `shopify.get_order`
        // results come back this tick. Used to flag a `refund.create` that
        // targets an order belonging to a different customer than the case
        // (prompt-injection scope guard — see refundCustomerMismatchFlag).
        const seenOrderEmails = new Map<string, string | null>();

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
              continue;
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
              const existingFlags = Array.isArray(current.context["riskFlags"])
                ? (current.context["riskFlags"] as unknown[]).filter(
                    (f): f is string => typeof f === "string",
                  )
                : [];
              if (!existingFlags.includes(mismatchFlag)) {
                const patched: Record<string, unknown> = {
                  ...current.context,
                  riskFlags: [...existingFlags, mismatchFlag],
                };
                current = yield* cases
                  .update(current.id, { context: patched as never })
                  .pipe(Effect.catchAll(() => Effect.succeed(current)));
              }
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
            continue;
          }

          if (effectivePermission === "ask") {
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
            // Same best-effort fan-out on the merchant's push channel
            // (master-plan §9): the chat ping carries the same signed
            // decision links as the email.
            yield* notifyMerchant(
              current.tenantId,
              approvalRequestedNotification({
                caseId: current.id,
                toolName: tool.name,
                draftSubject,
                draftPreview,
                approveUrl,
                rejectUrl,
              }),
            );

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
            // Index our outbound reply's Message-ID for thread correlation of
            // the customer's eventual reply (best-effort, no-op for non-reply
            // tools).
            yield* recordOutboundReplyId(current, tool.name, exec.right);
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
              current = yield* tx.run(
                Effect.gen(function* () {
                  const updated = yield* cases.transitionStatus(
                    current.id,
                    "waiting_for_supplier",
                    { reason: "supplier.escalate" },
                  );
                  yield* audit.record({
                    tenantId: updated.tenantId,
                    caseId: updated.id,
                    actor: { type: "agent", id: agent.id },
                    action: "case.waiting_for_supplier",
                    details: { tool: tool.name, callId: decision.callId },
                  });
                  return updated;
                }),
              );
              return { type: "PausedWaitingForSupplier" } as const;
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
              );
              return {
                type: "HumanTakeoverRequired",
                reason: REPLY_DELIVERY_FAILED_FLAG,
              } as const;
            }
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
