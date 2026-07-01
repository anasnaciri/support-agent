import { Context, Effect } from "effect";
import {
  type AgentConfig,
  type AnyTool,
  type ApprovalRiskLevel,
  type CaseChannel,
  type ChatMessage,
  type ConversationThread,
  type DomainEvent,
  type InboundMessage,
  type ThreadId,
  wrapUntrusted,
  UNTRUSTED_PREAMBLE,
  AgentId as makeAgentId,
  TenantId as makeTenantId,
  ThreadId as makeThreadId,
} from "@support-agent/agent-core";
import { CaseRepository } from "./case-repository.js";
import { parseThreadId } from "./conversation-thread-id.js";
import { parseRefundAmount } from "./permission-service-live.js";
import type { AgentOverride } from "./tenant-agent-overrides.js";
import type {
  ResolutionPolicy,
  ScenarioPolicy,
  SupplierMode,
  TenantSettings,
} from "./tenant-repository.js";

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

export const eventToCaseLookup = (event: DomainEvent): CaseLookup | null => {
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
/** One merchant-defined specialist the current agent may hand off to. */
export interface HandoffSpecialist {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly whenToUse: string | null;
}

/**
 * The custom specialists (loaded once per tick) that opted to be callable from
 * `agentId`. Pure — drives both the prompt roster and the handoff allowlist so
 * the two never disagree.
 */
export const specialistsCallableFrom = (
  all: ReadonlyArray<{
    readonly id: AgentConfig["id"];
    readonly name: string;
    readonly description: string;
    readonly whenToUse: string | null;
    readonly callableFrom: ReadonlyArray<AgentConfig["id"]>;
  }>,
  agentId: string,
): ReadonlyArray<HandoffSpecialist> =>
  all
    .filter((s) =>
      s.callableFrom.some((c) => (c as string) === agentId),
    )
    .map((s) => ({
      id: s.id as string,
      name: s.name,
      description: s.description,
      whenToUse: s.whenToUse,
    }));

/**
 * The agent's effective handoff target ids: its static `handoffs` ∪ the custom
 * specialists that opted to be callable from it. The runtime validates a
 * handoff against this set so a merchant-defined inbound route is allowed.
 */
export const effectiveHandoffIds = (
  agent: Pick<AgentConfig, "id" | "handoffs">,
  all: ReadonlyArray<{
    readonly id: AgentConfig["id"];
    readonly callableFrom: ReadonlyArray<AgentConfig["id"]>;
  }>,
): ReadonlySet<string> => {
  const ids = new Set<string>(agent.handoffs.map((h) => h as string));
  for (const s of all) {
    if (s.callableFrom.some((c) => (c as string) === (agent.id as string))) {
      ids.add(s.id as string);
    }
  }
  return ids;
};

export const buildSystemPrompt = (
  agent: Pick<AgentConfig, "tools" | "promptTemplate">,
  tenantSettings: TenantSettings | null,
  knowledgeTitles: ReadonlyArray<string> = [],
  specialists: ReadonlyArray<HandoffSpecialist> = [],
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

  // Merchant-defined specialists that opted to be callable from THIS agent
  // (Phase C inbound routing). Listed as a trusted bracketed header — same
  // out-of-fence discipline as the supplier/knowledge headers — so the model
  // knows the custom targets exist (the runtime separately allows them). The
  // built-in routing prose is untouched; this is purely additive.
  if (specialists.length > 0) {
    const lines = specialists.map(
      (s) =>
        `- ${s.id} — "${s.name}": ${s.whenToUse?.trim() || s.description}`,
    );
    headers.push(
      [
        "[Additional specialists you can hand off to with agent.handoff (set targetAgent to the id):",
        ...lines,
        "]",
      ].join("\n"),
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
 * Trusted directive injected on a `where_is_order` case flagged as an
 * order/customer email mismatch. The mismatch is a HINT for the agent's
 * judgment, NOT a hard block: it shows BOTH emails (the customer's and the
 * order's) and asks the model to decide whether this is an obvious typo (the
 * same person) — in which case it may share the status — or genuinely different
 * people, in which case it should ask the customer to confirm the order's email
 * before disclosing. Security is NOT carried by this prompt: any
 * `conversation.reply` on an unverified mismatch is force-routed to human
 * approval (`shouldForceReplyApproval`) and a bare `final_message` parks for a
 * human (`hasUnverifiedOrderMismatch`), so the model can never auto-disclose
 * across a mismatch — the human is the backstop. Once the runtime has verified
 * an exact-email confirmation, the directive flips to PASSED (proceed). Returns
 * "" for every non-mismatch case, so normal flows are untouched. Stays OUTSIDE
 * the untrusted fence — runtime-authored, not customer text.
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
  const customerEmail =
    typeof context["customerEmail"] === "string"
      ? (context["customerEmail"] as string)
      : null;
  const orderEmail =
    typeof context["pendingOrderEmail"] === "string"
      ? (context["pendingOrderEmail"] as string)
      : null;
  const emailsLine =
    customerEmail && orderEmail
      ? `This customer is writing from ${customerEmail}, but ${orderRef} was placed under ${orderEmail}.`
      : `This customer is writing from a different email than the one ${orderRef} was placed under.`;
  return `[Possible identity mismatch${wiringNote}: ${emailsLine} This is often a harmless typo — a transposed, missing or extra letter usually means the SAME person — but it can also mean someone is asking about another person's order. Use your judgment: if the two addresses are clearly the same person with a small typo, go ahead and share the order status normally. If they look like genuinely different people, do NOT share order details — instead ask the customer to confirm the exact email used to place the order via conversation.ask_customer, and only share once it matches. When you are unsure, ask rather than disclose. (Any reply you send on a flagged case is reviewed by a human before it goes out, so explain your reasoning.)]`;
};

/**
 * Render a fetched conversation thread as a plain-text transcript, oldest
 * first, for inlining into a `case.resumed` prompt. Each line is labelled by
 * direction so the model can tell a customer message from a reply WE already
 * sent — that's the "what was already done" the agent needs to avoid redoing
 * work or contradicting an earlier promise. The caller fences the whole string
 * as untrusted (it contains customer-authored text), so this stays pure data.
 */
export const renderThreadTranscript = (thread: ConversationThread): string =>
  thread.messages
    .map((m) => {
      const who =
        m.direction === "inbound"
          ? `Customer <${m.from.email}>`
          : `You (support) <${m.from.email}>`;
      const subject = m.subject ? ` — ${m.subject}` : "";
      const attachments =
        m.attachments.length > 0
          ? `\n[attachments: ${m.attachments
              .map((a) => a.filename)
              .join(", ")}]`
          : "";
      const body =
        m.bodyText.trim().length > 0 ? m.bodyText.trim() : "(empty message)";
      return `[${m.sentAt.toISOString()}] ${who}${subject}\n${body}${attachments}`;
    })
    .join("\n\n");

/**
 * The customer's address for an inbound message. Mail delivered through a
 * relay — e.g. a Shopify storefront contact form, sent
 * `From: mailer@shopify.com` with `Reply-To:` set to the shopper — carries
 * the real customer in `Reply-To`. Prefer it over `from` so the stamped
 * `customerEmail`, the reply recipient, and identity checks all target the
 * human rather than the relay. Falls back to `from` for ordinary mail (and
 * when a Reply-To with an empty address slips through).
 */
export const inboundCustomerEmail = (
  payload: Pick<InboundMessage, "from" | "replyTo">,
): string => payload.replyTo?.email || payload.from.email;

/**
 * The customer's display name from an inbound message, if the From/Reply-To
 * header carried one ("Maya Chen" <maya@…>). Mirrors {@link inboundCustomerEmail}:
 * when Reply-To is present it's the human (relay-delivered mail), so trust ONLY
 * its name — never fall back to the relay's From name. Null when no usable name
 * is present. Stamped onto `context.customerName` so cases are searchable by
 * name, not just email.
 */
export const inboundCustomerName = (
  payload: Pick<InboundMessage, "from" | "replyTo">,
): string | null => {
  const raw = payload.replyTo ? payload.replyTo.name : payload.from.name;
  const name = raw?.trim();
  return name ? name : null;
};

export const buildInitialMessages = (
  event: DomainEvent,
  caseRow: {
    readonly subject: string | null;
    readonly threadId: ThreadId | null;
    readonly context: Record<string, unknown>;
    /**
     * The full thread transcript, pre-fetched by the runtime on a
     * `case.resumed` tick (see `renderThreadTranscript`). When present it is
     * inlined so even an agent WITHOUT the `conversation.fetch_thread` tool
     * (support-triage) re-orients on the real conversation. Absent/null on a
     * connector hiccup or a lean layer → the agent is told to fetch it itself.
     */
    readonly threadTranscript?: string | null;
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
    // The identity gate (unverified order/customer mismatch) takes precedence;
    // otherwise hand the agent the canonical bound order so it answers from the
    // single source of truth instead of re-searching the customer's quoted code.
    const directive =
      orderIdentityDirective(caseRow.context, caseRow.threadId) ||
      boundOrderDirective(caseRow.context);
    // A reply tick otherwise carries ONLY the latest message — hand the agent
    // the established case facts (trusted, outside the fence) so it acts on the
    // whole case, not just the newest line.
    const facts = caseFactsHeader(caseRow.context);
    const body = wrapUntrusted(event.payload.bodyText ?? "(empty reply)");
    const preamble = [directive, facts].filter(Boolean).join("\n\n");
    return [
      buildUserMessageFromInbound(
        preamble ? `${preamble}\n\n${body}` : body,
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
    const header = `[Thread context: threadId=${event.threadId}, from=${inboundCustomerEmail(event.payload)}]`;
    const directive =
      orderIdentityDirective(caseRow.context, caseRow.threadId) ||
      boundOrderDirective(caseRow.context);
    const facts = caseFactsHeader(caseRow.context);
    const customerBlock = wrapUntrusted(
      `Subject: ${subject}\n\n${event.payload.bodyText}`,
    );
    const trusted = [header, directive, facts].filter(Boolean).join("\n\n");
    return [
      buildUserMessageFromInbound(
        `${trusted}\n\n${customerBlock}`,
        event.payload.attachments,
      ),
    ];
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
    // Trusted (outside the fenced context blob): the identity-disclosure gate
    // takes precedence (a resumed where_is_order with an unverified
    // order/customer mismatch must be told to challenge, NOT answer — the
    // inbound/reply paths already inject this, the resume path used to skip it);
    // otherwise hand the agent the canonical bound order so it loads by GID
    // rather than re-searching.
    const directive =
      orderIdentityDirective(caseRow.context, caseRow.threadId) ||
      boundOrderDirective(caseRow.context);
    if (directive) {
      parts.push(directive);
    }
    // The full context blob is inlined below (fenced, since it also holds the
    // agent's free-text). Surface the trusted, closed-vocab subset here too so
    // the agent can rely on it without trusting the fenced copy.
    const facts = caseFactsHeader(caseRow.context);
    if (facts) {
      parts.push(facts);
    }
    // If the runtime pre-fetched the thread, inline the whole conversation
    // (customer messages AND replies we already sent), fenced as untrusted.
    // This is what lets a restart-from-triage actually "know what was already
    // done" — support-triage has no conversation.fetch_thread tool, so without
    // this it would re-classify from the subject alone.
    const transcript = caseRow.threadTranscript?.trim();
    if (transcript) {
      parts.push(
        `Conversation so far (oldest first — includes replies already sent):\n${wrapUntrusted(
          transcript,
        )}`,
      );
    }
    if (caseRow.threadId) {
      // Always steer toward a concrete TOOL action. A resumed agent that just
      // writes its answer as a plain `final_message` neither sends anything to
      // the customer nor parks correctly — the runtime would silently resolve a
      // live case (prod 3428f154). Make "take an action" explicit for both the
      // transcript-inlined and the self-fetch path.
      parts.push(
        transcript
          ? "Re-read the full conversation above and take into account what has already been said and done. Then take a concrete next action with your tools (reply to the customer, ask them a question, escalate, or hand off) — do NOT finish by writing your answer as a plain message."
          : "Start by calling conversation.fetch_thread with the threadId above to review the conversation so far, then take a concrete next action with your tools (reply, ask the customer, escalate, or hand off) — do NOT finish by writing your answer as a plain message.",
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
export const derivePreview = (input: unknown): string => {
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

export const deriveSubject = (input: unknown): string | null => {
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
export const executionKeyFor = (
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
 * their own correlation id. A manager `case.resumed` retry mints a fresh
 * `resumeToken`, so each restart re-runs the agent's tools (a stable-`draftId`
 * reply/ask no longer cross-dedups against the PRIOR attempt) while a pg-boss
 * redelivery of the SAME retry keeps the token and still can't double-send.
 * `supplier.updated` / `manual.takeover` carry no per-delivery id, so they fall
 * back to the case id (two of the same on one case could cross-dedup — rare).
 */
export const deliveryScopeFor = (event: DomainEvent): string => {
  const scoped = ((): string | undefined => {
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
      case "case.resumed":
        return event.resumeToken
          ? `case:${event.caseId}:${event.resumeToken}`
          : `case:${event.caseId}`;
      case "supplier.updated":
      case "manual.takeover":
        return `case:${event.caseId}`;
    }
  })();
  if (scoped) return scoped;
  // Defensive backstop (prod 3428f154): the switch is exhaustive over the known
  // DomainEvent union, but a MALFORMED event reaching the runtime (a `type` no
  // case matches) would otherwise fall through to `undefined` → an UNSCOPED
  // execution key. A bare key collides with a legacy, pre-scoping marker
  // (`conversation.reply:<draftId>`) and silently dedups a fresh customer reply
  // — the where_is_order case then auto-resolves with nothing sent. Never key
  // bare: namespace by the case id when present (so a send can't collide with a
  // bare legacy marker), else by the event type. Keeps the redelivery guarantee
  // while making the silent-swallow impossible regardless of event shape.
  const caseId = (event as { readonly caseId?: unknown }).caseId;
  return typeof caseId === "string" && caseId.length > 0
    ? `case:${caseId}`
    : `event:${(event as { readonly type?: unknown }).type ?? "unknown"}`;
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

export const refundAuditDetails = (
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
export const deriveTickLockKey = (
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
export const normalizeEmailForMatch = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return v === "" ? null : v;
};

/** A canonical Shopify order GID (`gid://shopify/Order/<n>`). */
const isOrderGid = (v: unknown): v is string =>
  typeof v === "string" && v.startsWith("gid://shopify/Order/");

/**
 * The value to stamp into `case.context.identifiedOrderId` after the runtime
 * resolves a concrete order through an order tool (`shopify.get_order` /
 * `shopify.find_customer_order`). This is the case's single source of truth for
 * "which order is this about": every consumer (the agent's `boundOrderDirective`,
 * the dashboard order panel, the Issue-refund button) re-resolves it EXACTLY via
 * `getOrder(gid)` — never a fuzzy name/confirmation search that can diverge.
 *
 * We bind only the stable Shopify GID. The customer-facing name (`#1001`) and the
 * confirmation number (`XPAV284CT`) are fuzzy human references that each consumer
 * would re-search differently (and some, like a mistyped confirmation code, miss
 * entirely) — so they are kept as the untrusted `quotedOrderRef` hint and never
 * promoted to the canonical field. Returns null when the order carries no GID
 * (nothing stable to bind).
 */
export const orderContextRef = (order: {
  readonly id?: unknown;
  readonly name?: unknown;
}): string | null => {
  const id = typeof order.id === "string" ? order.id.trim() : "";
  return id.length > 0 ? id : null;
};

/**
 * Trusted directive that hands the agent the order already bound to the case so
 * it answers from the single source of truth instead of re-searching by the
 * customer's quoted (and possibly wrong) order number / confirmation code — the
 * scatter that let a case with a real order still draft "I can't find your
 * order". Fires only once `identifiedOrderId` holds a canonical GID; a legacy
 * fuzzy value or an unresolved case yields "" (the agent resolves normally).
 * Stays OUTSIDE the untrusted fence — runtime-authored, not customer text.
 */
export const boundOrderDirective = (
  context: Record<string, unknown>,
): string => {
  const gid = context["identifiedOrderId"];
  if (!isOrderGid(gid)) return "";
  return `[This case already has an identified order: ${gid}. Load it with shopify.get_order using exactly that id; do NOT search for the order again by any name or confirmation code the customer quoted.]`;
};

/**
 * Trusted, compact summary of the substantive facts the system already knows
 * about a case, injected OUTSIDE the untrusted fence on inbound and reply ticks
 * so the agent reasons from the full picture rather than re-deriving it — or, on
 * a customer reply (which otherwise carries ONLY the latest message), flying
 * blind on what was already established. The order id and the identity-mismatch
 * specifics have their own directives ({@link boundOrderDirective} /
 * orderIdentityDirective); this carries the rest of the case substance.
 *
 * Includes ONLY runtime-owned fields (`customerEmail`, `verifiedCustomerEmail`,
 * `identityVerified`) and closed-vocabulary agent fields (`classification`,
 * `requestedResolution`, `returnReason`, `productMatch`,
 * `liveTrackingStatus.status`) — each a literal union, never free text. It
 * deliberately OMITS the agent's free-text `notes` and the untrusted customer
 * string `quotedOrderRef`, which stay inside the fence, so this header itself
 * can be trusted (a prompt-injected body can't reach it). Returns null when the
 * case has no established facts yet (a fresh inbound), so normal first-touch
 * flows are untouched.
 */
export const caseFactsHeader = (
  context: Record<string, unknown>,
): string | null => {
  const str = (k: string): string | null =>
    typeof context[k] === "string" && (context[k] as string).length > 0
      ? (context[k] as string)
      : null;

  const facts: string[] = [];
  const customerEmail = str("customerEmail");
  if (customerEmail) facts.push(`customer=${customerEmail}`);
  const verified = str("verifiedCustomerEmail");
  if (verified) facts.push(`verifiedOrderEmail=${verified}`);
  const classification = str("classification");
  if (classification) facts.push(`classification=${classification}`);
  const requested = str("requestedResolution");
  if (requested) facts.push(`requestedResolution=${requested}`);
  const returnReason = str("returnReason");
  if (returnReason) facts.push(`returnReason=${returnReason}`);
  const productMatch = str("productMatch");
  if (productMatch) facts.push(`photoMatch=${productMatch}`);
  const tracking = context["liveTrackingStatus"];
  if (
    tracking !== null &&
    typeof tracking === "object" &&
    typeof (tracking as { status?: unknown }).status === "string"
  ) {
    facts.push(`tracking=${(tracking as { status: string }).status}`);
  }
  if (context["identityVerified"] === true) facts.push("identityVerified=yes");

  if (facts.length === 0) return null;
  return `[Case facts known to the system — treat these as established, don't re-derive or contradict them: ${facts.join("; ")}]`;
};

/** Read `context.riskFlags` as a string array (the runtime's fraud/guard chips). */
export const readRiskFlags = (context: Record<string, unknown>): string[] =>
  Array.isArray(context["riskFlags"])
    ? (context["riskFlags"] as unknown[]).filter(
        (f): f is string => typeof f === "string",
      )
    : [];

/**
 * Whether the case carries an order/customer identity mismatch the runtime has
 * NOT yet verified — i.e. the disclosure gate is still closed. The runtime uses
 * this to refuse to auto-resolve such a case on a bare `final_message`: we never
 * confirmed we're talking to the right person, so silently closing would leave a
 * live case unanswered (prod 3428f154: a resumed order-status-agent drafted a
 * prose answer instead of replying/challenging and the case auto-resolved).
 * Pure + exported so the decision is unit-tested without the runtime.
 */
export const hasUnverifiedOrderMismatch = (
  context: Record<string, unknown>,
): boolean =>
  readRiskFlags(context).includes("order_customer_mismatch") &&
  context["identityVerified"] !== true;

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
 * Decide, in the runtime (never the model), what to stamp on the case when a
 * customer's inbound reply answers the order-status identity challenge. Returns
 * the context patch — `identityVerified` plus the now-confirmed
 * `verifiedCustomerEmail` — when the reply proves the order's email, else null.
 *
 * The saved `verifiedCustomerEmail` is the TRUSTED order email the runtime
 * stamped at detection (`pendingOrderEmail`, read from the Shopify order), NOT a
 * token lifted out of the (untrusted) reply text — so a prompt-injected body can
 * neither fake a pass ({@link replyProvesOrderIdentity} matches against the order
 * email) nor plant an arbitrary address as the "verified" one. Mirrors the
 * surrounding pure guards so the decision is unit-tested without the runtime;
 * the caller still scopes this to inbound message events and persists the patch.
 */
export const orderIdentityVerificationPatch = (
  replyText: unknown,
  context: Record<string, unknown>,
): { identityVerified: true; verifiedCustomerEmail: string } | null => {
  if (context["identityVerified"] === true) return null;
  if (!readRiskFlags(context).includes("order_customer_mismatch")) return null;
  const pending = context["pendingOrderEmail"];
  if (typeof pending !== "string" || pending.length === 0) return null;
  if (!replyProvesOrderIdentity(replyText, pending)) return null;
  return { identityVerified: true, verifiedCustomerEmail: pending };
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

export const riskFor = (tool: AnyTool): ApprovalRiskLevel => {
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
// Scenario envelope (autonomous loop steering)
// ============================================================

/**
 * Remedy tools whose presence + permission are controlled by a scenario's
 * `enabledActions` (the HARD gate). Every OTHER tool the agent declares is a
 * baseline tool — reads, the customer channel, knowledge, context, the merchant
 * heads-up, the refund RECOMMENDATION (no money moves) — and is always
 * presented. `supplier.escalate` is gated separately by `supplierMode`.
 */
export const SCENARIO_REMEDY_TOOLS: ReadonlySet<string> = new Set([
  "refund.create",
  "discount.create",
  "order.cancel",
]);

const SUPPLIER_ESCALATE_TOOL = "supplier.escalate";

const supplierGuidanceLine = (mode: SupplierMode): string => {
  switch (mode) {
    case "escalate_and_wait":
      return "If a supplier needs to act, escalate to them with supplier.escalate and WAIT for their response before resolving — do not promise the customer a resolution you can't yet deliver.";
    case "notify_and_proceed":
      return "If a supplier needs to act, escalate to them with supplier.escalate AND proceed to help the customer (e.g. set expectations in your reply) without waiting for the supplier.";
    case "none":
      return "Do NOT involve a supplier for this scenario.";
  }
};

/**
 * The trusted `[Scenario playbook: ...]` header injected into the autonomous
 * agent's prompt. The merchant's free-text `notes` are the soft, LLM-interpreted
 * guidance; the supplier line restates `supplierMode` in plain language. Lives
 * OUTSIDE the untrusted fence (it's merchant config, not customer content).
 */
export const buildScenarioPlaybookHeader = (scenario: ScenarioPolicy): string => {
  const lines = [`[Scenario playbook — "${scenario.label}":`];
  const notes = scenario.notes?.trim();
  if (notes) lines.push(notes);
  lines.push(supplierGuidanceLine(scenario.supplierMode));
  lines.push("]");
  return lines.join("\n");
};

/**
 * Clamp an autonomous agent to a scenario's envelope (master-plan: scenario
 * agent). Pure + exported for unit testing. Layers ON TOP of `applyOverride`
 * (call it after), returning a new AgentConfig:
 *   - tools = baseline ∪ enabled remedies ∪ (supplier.escalate iff supplierMode
 *     != none). A remedy the scenario didn't enable is REMOVED from the schema
 *     list so the model can't call it.
 *   - permissionOverrides: each enabled remedy → its allow/ask; each remedy the
 *     agent declares but the scenario didn't enable → deny (defense in depth on
 *     top of the schema removal); supplier.escalate → deny when supplierMode is
 *     none. Scenario permissions win over the incoming map (they're the more
 *     specific, scenario-scoped intent).
 *   - promptTemplate gains the trusted playbook header (flows through
 *     buildSystemPrompt for the whole tick).
 * Enforcement guards (spending caps, the unverified-mismatch backstop) still
 * apply on top at the permission check — this only narrows cognition.
 */
export const applyScenarioEnvelope = (
  agent: AgentConfig,
  scenario: ScenarioPolicy,
): AgentConfig => {
  const enabledPermissionByTool = new Map<string, "allow" | "ask">(
    scenario.enabledActions
      .filter((a) => SCENARIO_REMEDY_TOOLS.has(a.tool))
      .map((a) => [a.tool, a.permission]),
  );
  const supplierEnabled = scenario.supplierMode !== "none";

  const tools = agent.tools.filter((t) => {
    const name = t as string;
    if (SCENARIO_REMEDY_TOOLS.has(name)) return enabledPermissionByTool.has(name);
    if (name === SUPPLIER_ESCALATE_TOOL) return supplierEnabled;
    return true;
  });

  const permissionOverrides: Record<string, AgentConfig["permissionOverrides"][string]> = {
    ...agent.permissionOverrides,
  };
  for (const t of agent.tools) {
    const name = t as string;
    if (SCENARIO_REMEDY_TOOLS.has(name)) {
      const enabled = enabledPermissionByTool.get(name);
      permissionOverrides[name] = enabled ?? "deny";
    }
  }
  if (
    agent.tools.some((t) => (t as string) === SUPPLIER_ESCALATE_TOOL) &&
    !supplierEnabled
  ) {
    permissionOverrides[SUPPLIER_ESCALATE_TOOL] = "deny";
  }

  return {
    ...agent,
    tools,
    permissionOverrides,
    promptTemplate: `${agent.promptTemplate}\n\n${buildScenarioPlaybookHeader(scenario)}`,
  };
};

/**
 * Apply a scenario to an autonomous agent as STEERING ONLY — inject the playbook
 * header (label + notes + supplier guidance) and leave `tools` /
 * `permissionOverrides` untouched (2026-06-28). This is what the runtime wires
 * in now: tools/permissions are configured once on the agent (per-agent config),
 * not per scenario. The richer `applyScenarioEnvelope` above (which also clamps
 * the tool set per `enabledActions`) is retained + tested for the resurface
 * path, but no longer called by the runtime. Pure + exported for unit testing.
 */
export const applyScenarioSteering = (
  agent: AgentConfig,
  scenario: ScenarioPolicy,
): AgentConfig => ({
  ...agent,
  promptTemplate: `${agent.promptTemplate}\n\n${buildScenarioPlaybookHeader(scenario)}`,
});

/** The id of the autonomous resolution agent triage routes to (slice 6). */
export const SCENARIO_RESOLUTION_AGENT_ID = "scenario-resolution-agent";

/**
 * Re-route support-triage to the scenario-resolution-agent when the tenant has
 * the resolution agent enabled (slice 6). Pure + exported for unit testing;
 * the runtime gates the call on `resolutionAgentEnabled` and the agent being
 * triage. Returns a triage AgentConfig that:
 *   - adds `scenario-resolution-agent` to `handoffs` (so the handoff allowlist
 *     — effectiveHandoffIds — permits it), deduped;
 *   - appends a trusted routing header listing each scenario (key +
 *     recognition) and instructing triage to stamp `scenarioKey` via
 *     case.update_context and hand off to the resolution agent, preferring it
 *     over the built-in specialists for any matching case.
 * Both flow through the runtime automatically (effectiveHandoffIds reads
 * `handoffs`; buildSystemPrompt reads `promptTemplate`). Only ENABLED scenarios
 * are offered (a disabled one falls back to the built-in specialists); no
 * enabled scenarios → no-op (triage routes as if the agent were off).
 */
export const applyTriageScenarioRouting = (
  agent: AgentConfig,
  policy: ResolutionPolicy,
): AgentConfig => {
  const active = policy.scenarios.filter((s) => s.enabled !== false);
  if (active.length === 0) return agent;
  const lines = active.map(
    (s) =>
      `- ${s.key} — "${s.label}": ${
        s.recognition?.trim() || s.notes?.trim() || s.label
      }`,
  );
  const header = [
    "[Resolution scenarios — this store routes matching cases to the resolution agent. For a case that fits ONE of these scenarios, PREFER this over the built-in specialists:",
    ...lines,
    "",
    'To route a matching case: (1) call case.update_context with `scenarioKey` set to the matching scenario\'s key (keep your usual `classification`/`quotedOrderRef`/`notes` too), then (2) call agent.handoff with targetAgent "scenario-resolution-agent". Only fall back to a built-in specialist when the case fits NONE of the scenarios above.]',
  ].join("\n");
  const alreadyListed = agent.handoffs.some(
    (h) => (h as string) === SCENARIO_RESOLUTION_AGENT_ID,
  );
  const handoffs = alreadyListed
    ? agent.handoffs
    : [...agent.handoffs, makeAgentId(SCENARIO_RESOLUTION_AGENT_ID)];
  return {
    ...agent,
    handoffs,
    promptTemplate: `${agent.promptTemplate}\n\n${header}`,
  };
};

/**
 * Resolution-agent-direct entry (2026-06-28). When the tenant has the resolution
 * agent enabled, inbound cases run the scenario-resolution-agent DIRECTLY (no
 * support-triage hop). This wraps that agent with a steering header so it picks
 * the matching scenario ITSELF as its first step — replacing the brittle
 * triage→handoff classification that intermittently silently-resolved cases.
 *
 * Unlike `applyScenarioEnvelope`, this does NOT touch `tools` or
 * `permissionOverrides`: tools/permissions are configured ONCE on the agent now
 * (per-agent config + the /settings/agents permission toggle). The scenario
 * contributes STEERING only — recognition (to pick) plus each scenario's notes
 * and supplier guidance (to act). Per-scenario tool clamping
 * (`ScenarioPolicy.enabledActions`) is intentionally retained in the model but
 * not applied here; see todo "RESURFACE LATER: fine-grained per-scenario tool
 * control".
 *
 * No enabled scenarios → no-op (the agent runs on its base prompt). Pure +
 * exported for unit testing; the runtime gates the call on
 * `resolutionAgentEnabled` and the resolved agent being the primary entry.
 */
export const applyResolutionAgentEntry = (
  agent: AgentConfig,
  policy: ResolutionPolicy,
): AgentConfig => {
  const active = policy.scenarios.filter((s) => s.enabled !== false);
  if (active.length === 0) return agent;
  const lines = active.map((s) => {
    const recognition = s.recognition?.trim() || s.notes?.trim() || s.label;
    const notes = s.notes?.trim();
    const guidance = supplierGuidanceLine(s.supplierMode);
    const detail = [recognition, notes && notes !== recognition ? notes : null]
      .filter(Boolean)
      .join(" ");
    return `- ${s.key} — "${s.label}": ${detail} (${guidance})`;
  });
  const header = [
    "[Resolution scenarios — you are the entry point for this store. FIRST, read the customer's message and decide which ONE of these scenarios it matches:",
    ...lines,
    "",
    "As your FIRST action, call case.update_context with `scenarioKey` set to the matching scenario's key (and `classification`/`quotedOrderRef`/`notes` when useful). Then follow that scenario's guidance to resolve the case end-to-end using your available tools.",
    "If the message genuinely fits NONE of these scenarios — spam, an offer/solicitation, or something only a human should decide — do NOT guess and do NOT send a customer reply: call merchant.notify and stop with a brief final message, which parks the case for a human. Never close a real customer's case without helping them.]",
  ].join("\n");
  return {
    ...agent,
    promptTemplate: `${agent.promptTemplate}\n\n${header}`,
  };
};

// ============================================================
// Tool-call timeout
// ============================================================

/**
 * Default wall-clock bound applied to a tool call when the tool doesn't
 * declare its own `timeout`. No first-party tool declares one, so without this
 * a hung connector call (Shopify / 17track / knowledge HTTP) would run
 * unbounded and pin the worker's tick. Kept below the LLM-call (90s) and
 * per-tick (180s) budgets so one hung tool fails first. Env override:
 * `TOOL_CALL_TIMEOUT_MS` (clamped 1s–300s).
 */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000;
const MIN_TOOL_CALL_TIMEOUT_MS = 1_000;
const MAX_TOOL_CALL_TIMEOUT_MS = 300_000;

export const toolCallTimeoutMs = (
  env: Record<string, string | undefined>,
): number => {
  const raw = env["TOOL_CALL_TIMEOUT_MS"];
  if (raw === undefined) return DEFAULT_TOOL_CALL_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_TOOL_CALL_TIMEOUT_MS;
  return Math.max(
    MIN_TOOL_CALL_TIMEOUT_MS,
    Math.min(MAX_TOOL_CALL_TIMEOUT_MS, n),
  );
};
