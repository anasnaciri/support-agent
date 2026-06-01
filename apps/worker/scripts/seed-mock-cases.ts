/**
 * Seed deterministic, dashboard-ready mock cases for the missing-package
 * and damaged-product agents — one case per decision branch / outcome.
 *
 * This writes `cases`, `case_state_transitions`, `audit_log`, `approvals`,
 * and `timers` rows DIRECTLY into the database. It does NOT run the LLM,
 * Shopify, or Gmail — every row is hand-built to match exactly what the
 * real `AgentRuntime` would have written, so the resulting cases are
 * indistinguishable from organic ones in the dashboard (timeline, approval
 * card, customer/order panels degrade gracefully, productMatch badge, …).
 *
 * An "inbound email" is just an `event.received` audit row + the case's
 * `context.customerEmail` / `threadId` / `subject`; an "outbound reply" is
 * a `tool.invoked` (conversation.reply / ask_customer) row. No mail is sent.
 *
 * Re-runnable: every case has a fixed UUID, so each run deletes the prior
 * mock rows (and their dependents) before re-inserting.
 *
 * Usage (from repo root):
 *   pnpm --filter @support-agent/worker exec \
 *     node --env-file=.env.local --import tsx scripts/seed-mock-cases.ts
 *
 * Defaults to tenant 1ba5d40a-... (Anas's Support Team, 12anas2000@gmail.com).
 * Override with `--tenant <uuid>`. Pass `--clean` to only delete the mock
 * cases and exit (no re-insert).
 */

import { randomBytes, randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import {
  makeDbClient,
  cases,
  caseStateTransitions,
  auditLog,
  approvals,
  timers,
  type CaseInsert,
  type CaseStateTransitionInsert,
  type AuditLogInsert,
  type ApprovalInsert,
  type TimerInsert,
} from "@support-agent/db";

const DEFAULT_TENANT = "1ba5d40a-6a8f-49d7-b5fc-136e4b9265a5";
// Stable id for the "manager who approved" on resolved cases. Any uuid is
// fine — the dashboard renders the audit row's actor as a user.
const MANAGER_ID = "9a9a9a9a-0000-4000-8000-000000000001";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

type Actor =
  | { readonly type: "system"; readonly id: "runtime" }
  | { readonly type: "agent"; readonly id: string }
  | { readonly type: "user"; readonly id: string };

const SYS: Actor = { type: "system", id: "runtime" };
const TRIAGE: Actor = { type: "agent", id: "support-triage" };

const hex16 = (): string => randomBytes(8).toString("hex");
const callId = (tool: string): string =>
  `tool_${tool}_${randomBytes(10).toString("hex").slice(0, 20)}`;

/** A specialist tool that actually executed (permission `allow`). */
type ToolStep = {
  readonly tool: string;
  readonly ok?: boolean;
  // Captured into the `tool.invoked` audit `details.output` — only the
  // runtime does this for `refund.recommend`, and the dashboard renders a
  // recommendation block from it.
  readonly output?: Record<string, unknown>;
};

type Terminal =
  | {
      readonly kind: "approval";
      readonly resolved?: boolean;
      readonly replyBody: string;
      readonly draftId: string;
    }
  | {
      // A `refund.create` (risk `money` → riskLevel `high`) gated by `ask`.
      // This is the "approve a refund" approval, raised by refund-review-agent.
      readonly kind: "refundApproval";
      readonly resolved?: boolean;
      readonly orderGid: string;
      readonly amount: string; // decimal string, e.g. "42.00"
      readonly currencyCode: string;
      readonly reason: string;
      readonly notifyCustomer?: boolean;
    }
  | {
      readonly kind: "askCustomer";
      readonly body: string;
      readonly draftId: string;
      readonly withTimer?: boolean;
    }
  | { readonly kind: "finalMessage"; readonly text: string };

interface Scenario {
  readonly id: string;
  readonly agent: string;
  readonly category: string;
  readonly subject: string;
  readonly summary: string;
  readonly customerEmail: string;
  readonly customerName: string | null;
  readonly orderId: string; // e.g. "#1001"
  readonly shopifyOrderId: string | null;
  readonly handoffReason: string;
  readonly ageMinutes: number;
  readonly priority?: "low" | "normal" | "high" | "urgent";
  readonly productMatch?: "match" | "mismatch" | "uncertain";
  // EXIF rollup the runtime stamps from uploaded photos; surfaced as the
  // ApprovalCard "Photo EXIF" chip.
  readonly photoSignals?: {
    readonly count: number;
    readonly withExif: number;
    readonly stripped: number;
    readonly anyStripped: boolean;
  };
  // Risk flags the runtime stamps on the context (e.g. the duplicate-photo
  // guard); surfaced as ApprovalCard chips.
  readonly riskFlags?: readonly string[];
  /** Specialist tools that ran (allow) before the terminal step. */
  readonly executedTools: readonly ToolStep[];
  readonly terminal: Terminal;
}

interface BuiltRows {
  readonly caseRow: CaseInsert;
  readonly transitions: CaseStateTransitionInsert[];
  readonly audits: AuditLogInsert[];
  readonly approvals: ApprovalInsert[];
  readonly timers: TimerInsert[];
}

const build = (tenantId: string, s: Scenario): BuiltRows => {
  const id = s.id;
  const threadId = hex16();
  const createdAt = new Date(Date.now() - s.ageMinutes * 60 * 1000);
  const spec: Actor = { type: "agent", id: s.agent };

  const audits: AuditLogInsert[] = [];
  const transitions: CaseStateTransitionInsert[] = [];
  const approvalsOut: ApprovalInsert[] = [];
  const timersOut: TimerInsert[] = [];

  let seq = 0;
  const at = (): Date => new Date(createdAt.getTime() + seq++ * 1500);

  const pushAudit = (
    actor: Actor,
    action: string,
    details: Record<string, unknown>,
  ): void => {
    audits.push({
      tenantId,
      caseId: id,
      actorType: actor.type,
      actorId: actor.id,
      action,
      details,
      occurredAt: at(),
    });
  };

  const pushTransition = (
    fromStatus: string,
    toStatus: string,
    reason: string,
  ): void => {
    transitions.push({ caseId: id, fromStatus, toStatus, reason, occurredAt: at() });
  };

  // --- inbound + triage (every case starts the same way) -----------------
  pushAudit(SYS, "event.received", { eventType: "message.received" });
  pushAudit(TRIAGE, "llm.decision", { turn: 0, decisionType: "tool_call" });
  pushAudit(TRIAGE, "tool.invoked", {
    ok: true,
    tool: "case.update_context",
    callId: callId("case.update_context"),
  });
  pushAudit(TRIAGE, "llm.decision", { turn: 1, decisionType: "tool_call" });
  pushAudit(TRIAGE, "tool.invoked", {
    ok: true,
    tool: "agent.handoff",
    turn: 1,
    callId: callId("agent.handoff"),
    reason: s.handoffReason,
    target: s.agent,
  });

  // --- specialist phase ---------------------------------------------------
  let turn = 2;
  for (const step of s.executedTools) {
    pushAudit(spec, "llm.decision", { turn, decisionType: "tool_call" });
    pushAudit(spec, "tool.invoked", {
      ok: step.ok ?? true,
      tool: step.tool,
      callId: callId(step.tool),
      ...(step.output ? { output: step.output } : {}),
    });
    turn++;
  }

  // --- terminal -----------------------------------------------------------
  let status: string;
  let resolvedAt: Date | null = null;

  if (s.terminal.kind === "approval") {
    // conversation.reply is `ask` → the decision is logged but the tool does
    // NOT execute; the runtime parks the case on a pending approval row.
    pushAudit(spec, "llm.decision", { turn, decisionType: "tool_call" });
    const approvalId = randomUUID();
    const proposedInput = {
      to: [{ name: s.customerName, email: s.customerEmail }],
      draftId: s.terminal.draftId,
      subject: null,
      bodyHtml: null,
      bodyText: s.terminal.replyBody,
      threadId,
      inReplyToMessageId: null,
    };
    pushTransition("new", "waiting_for_approval", "tool conversation.reply pending approval");
    status = "waiting_for_approval";

    const resolved = s.terminal.resolved ?? false;
    approvalsOut.push({
      id: approvalId,
      tenantId,
      caseId: id,
      agentId: s.agent,
      tool: "conversation.reply",
      proposedInput,
      approvedInput: resolved ? proposedInput : null,
      reasoning: "",
      riskLevel: "medium",
      status: resolved ? "approved" : "pending",
      decidedBy: resolved ? MANAGER_ID : null,
      decidedAt: resolved ? at() : null,
      decisionReason: resolved ? "Approved from dashboard" : null,
      expiresAt: new Date(createdAt.getTime() + DAY),
      createdAt: new Date(createdAt.getTime() + seq * 1500),
    });

    if (resolved) {
      pushAudit(SYS, "event.received", { eventType: "approval.approved" });
      const user: Actor = { type: "user", id: MANAGER_ID };
      pushAudit(user, "tool.invoked", {
        ok: true,
        tool: "conversation.reply",
        callId: `approval-${approvalId}`,
        viaApprovalId: approvalId,
      });
      pushAudit(user, "case.resolved", {
        tool: "conversation.reply",
        viaApprovalId: approvalId,
      });
      pushTransition("waiting_for_approval", "resolved", "approved tool conversation.reply");
      status = "resolved";
      resolvedAt = at();
    }
  } else if (s.terminal.kind === "refundApproval") {
    // refund.create is `ask` (risk money → riskLevel high). The decision is
    // logged; the tool does NOT execute; the case parks on a pending refund
    // approval — this is the "approve a refund" card in the dashboard.
    pushAudit(spec, "llm.decision", { turn, decisionType: "tool_call" });
    const approvalId = randomUUID();
    const proposedInput = {
      orderId: s.terminal.orderGid,
      amount: { amount: s.terminal.amount, currencyCode: s.terminal.currencyCode },
      reason: s.terminal.reason,
      notifyCustomer: s.terminal.notifyCustomer ?? true,
    };
    pushTransition("new", "waiting_for_approval", "tool refund.create pending approval");
    status = "waiting_for_approval";

    const resolved = s.terminal.resolved ?? false;
    approvalsOut.push({
      id: approvalId,
      tenantId,
      caseId: id,
      agentId: s.agent,
      tool: "refund.create",
      proposedInput,
      approvedInput: resolved ? proposedInput : null,
      reasoning: "",
      riskLevel: "high",
      status: resolved ? "approved" : "pending",
      decidedBy: resolved ? MANAGER_ID : null,
      decidedAt: resolved ? at() : null,
      decisionReason: resolved ? "Approved from dashboard" : null,
      expiresAt: new Date(createdAt.getTime() + DAY),
      createdAt: new Date(createdAt.getTime() + seq * 1500),
    });

    if (resolved) {
      pushAudit(SYS, "event.received", { eventType: "approval.approved" });
      const user: Actor = { type: "user", id: MANAGER_ID };
      pushAudit(user, "tool.invoked", {
        ok: true,
        tool: "refund.create",
        callId: `approval-${approvalId}`,
        viaApprovalId: approvalId,
      });
      pushAudit(user, "case.resolved", {
        tool: "refund.create",
        viaApprovalId: approvalId,
      });
      pushTransition("waiting_for_approval", "resolved", "approved tool refund.create");
      status = "resolved";
      resolvedAt = at();
    }
  } else if (s.terminal.kind === "askCustomer") {
    // conversation.ask_customer is `allow` → it executes and the case parks
    // in waiting_for_customer until the customer replies.
    pushAudit(spec, "llm.decision", { turn, decisionType: "tool_call" });
    const cid = callId("conversation.ask_customer");
    pushAudit(spec, "tool.invoked", {
      ok: true,
      tool: "conversation.ask_customer",
      callId: cid,
    });
    pushAudit(spec, "case.waiting_for_customer", {
      tool: "conversation.ask_customer",
      callId: cid,
    });
    pushTransition("new", "waiting_for_customer", "conversation.ask_customer");
    status = "waiting_for_customer";
    if (s.terminal.withTimer) {
      timersOut.push({
        id: randomUUID(),
        caseId: id,
        fireAt: new Date(createdAt.getTime() + 72 * HOUR),
        reason: "follow_up",
      });
    }
  } else {
    // finalMessage → the agent ended its turn with plain text (e.g. order
    // could not be located); the runtime resolves the case, no reply sent.
    pushAudit(spec, "llm.decision", { turn, decisionType: "final_message" });
    pushAudit(spec, "case.resolved", { turn, finalMessage: s.terminal.text });
    pushTransition("new", "resolved", "runtime: final_message");
    status = "resolved";
    resolvedAt = at();
  }

  const lastOccurredAt = audits[audits.length - 1]?.occurredAt ?? createdAt;
  const context: Record<string, unknown> = {
    notes: s.summary,
    customerEmail: s.customerEmail,
    classification: s.category,
    identifiedOrderId: s.orderId.replace(/^#/, ""),
    mockSeed: true,
  };
  if (s.productMatch) context["productMatch"] = s.productMatch;
  if (s.photoSignals) context["photoSignals"] = s.photoSignals;
  if (s.riskFlags && s.riskFlags.length > 0) context["riskFlags"] = s.riskFlags;

  const caseRow: CaseInsert = {
    id,
    tenantId,
    customerId: null,
    shopifyOrderId: s.shopifyOrderId,
    channel: "email",
    threadId,
    category: s.category,
    status,
    currentAgentId: s.agent,
    priority: s.priority ?? "normal",
    summary: s.summary,
    subject: s.subject,
    context,
    createdAt,
    updatedAt: lastOccurredAt,
    resolvedAt,
  };

  return { caseRow, transitions, audits, approvals: approvalsOut, timers: timersOut };
};

// id helper: 5eed00NN-0000-4000-8000-0000000000NN (deterministic, valid uuid)
const seedId = (n: number): string => {
  const h = n.toString(16).padStart(2, "0");
  return `5eed00${h}-0000-4000-8000-0000000000${h}`;
};

const MP = "missing-package-agent";
const DP = "damaged-product-agent";
const RR = "refund-review-agent";

const scenarios: readonly Scenario[] = [
  // ===================== MISSING PACKAGE AGENT =====================
  {
    id: seedId(1),
    agent: MP,
    category: "missing_package",
    subject: "Where is my order? Tracking says delivered but nothing here",
    summary: "Tracking shows delivered for #1001 but customer says it never arrived (BRANCH A — verify before reship).",
    customerEmail: "maya.delgado@example.com",
    customerName: "Maya Delgado",
    orderId: "#1001",
    shopifyOrderId: "1001",
    handoffReason: "Customer reports order #1001 not received though tracking shows delivered.",
    ageMinutes: 12,
    executedTools: [{ tool: "shopify.get_order" }],
    terminal: {
      kind: "approval",
      draftId: "missing-package-reply-1001",
      replyBody:
        "Hi Maya,\n\nThanks for letting us know. Our records show order #1001 was marked delivered by FedEx (tracking 778812340099) on May 26. Before we open a carrier claim, could you check a few common spots: your porch/mailbox, the building lobby, with household members, and any immediate neighbors? Please also confirm the delivery address matches what you expected.\n\nIf those come up empty, just reply here and we'll open a carrier claim and sort out a reshipment or refund.\n\nBest,\nSupport",
    },
  },
  {
    id: seedId(2),
    agent: MP,
    category: "missing_package",
    subject: "Package marked delivered — never received it",
    summary: "Delivered per carrier for #1002; logged to the warehouse escalation sheet, then verify-with-customer reply drafted (BRANCH A + supplier sheet).",
    customerEmail: "trevor.hughes@example.com",
    customerName: "Trevor Hughes",
    orderId: "#1002",
    shopifyOrderId: "1002",
    handoffReason: "Order #1002 shows delivered but customer says it's missing.",
    ageMinutes: 34,
    executedTools: [
      { tool: "shopify.get_order" },
      { tool: "supplier.add_sheet_row" },
    ],
    terminal: {
      kind: "approval",
      draftId: "missing-package-reply-1002",
      replyBody:
        "Hi Trevor,\n\nI'm sorry your order #1002 hasn't turned up — tracking (UPS 1Z99AA1099) shows it delivered on May 27. We've flagged it with our warehouse team to double-check the dispatch. In the meantime, could you check your porch, mailbox, building lobby, and with neighbors/household members, and confirm the shipping address?\n\nIf it's truly lost, reply here and we'll open a claim and arrange a reship or refund.\n\nBest,\nSupport",
    },
  },
  {
    id: seedId(3),
    agent: MP,
    category: "missing_package",
    subject: "My order is stuck in transit for over a week",
    summary: "#1003 in transit with no recent scans; carrier escalation reply drafted with 1-2 day SLA (BRANCH B).",
    customerEmail: "priya.nair@example.com",
    customerName: "Priya Nair",
    orderId: "#1003",
    shopifyOrderId: "1003",
    handoffReason: "Order #1003 stuck in transit, no movement for several days.",
    ageMinutes: 58,
    executedTools: [{ tool: "shopify.get_order" }],
    terminal: {
      kind: "approval",
      draftId: "missing-package-reply-1003",
      replyBody:
        "Hi Priya,\n\nYou're right that order #1003 has been quiet — the last scan from USPS (tracking 9400110200099) was on May 22, with an estimated delivery of May 25 that's now passed. I'm sorry for the wait.\n\nWe're escalating directly with the carrier to locate it; please allow 1-2 business days for them to respond. If you have any extra context (a safe-place note, neighborhood delivery patterns), reply here and it'll help us chase it.\n\nBest,\nSupport",
    },
  },
  {
    id: seedId(4),
    agent: MP,
    category: "missing_package",
    subject: "Ordered 10 days ago, hasn't shipped??",
    summary: "#1004 still unfulfilled — fulfillment-side breakdown; offered cancel+refund or fast-track (BRANCH C).",
    customerEmail: "deshawn.ford@example.com",
    customerName: "DeShawn Ford",
    orderId: "#1004",
    shopifyOrderId: "1004",
    handoffReason: "Order #1004 placed 10 days ago and still unfulfilled.",
    ageMinutes: 90,
    priority: "high",
    executedTools: [{ tool: "shopify.get_order" }],
    terminal: {
      kind: "approval",
      draftId: "missing-package-reply-1004",
      replyBody:
        "Hi DeShawn,\n\nI'm sorry — order #1004 (2× Aurora Desk Lamp, total $118.00) never shipped from our side, and that's on us, not the carrier. Here are two options:\n\n1) We cancel and refund order #1004 in full right now, or\n2) We fast-track the shipment and confirm a new delivery ETA within 1 business day.\n\nJust reply with which you'd prefer and we'll take care of it immediately.\n\nBest,\nSupport",
    },
  },
  {
    id: seedId(5),
    agent: MP,
    category: "missing_package",
    subject: "Where's my package for order 9999",
    summary: "Order id #9999 could not be located in Shopify; agent ended with a plain-text clarification request (case resolved, no reply sent).",
    customerEmail: "lost.order@example.com",
    customerName: null,
    orderId: "#9999",
    shopifyOrderId: "9999",
    handoffReason: "Customer asks about order #9999 (missing package).",
    ageMinutes: 140,
    executedTools: [{ tool: "shopify.get_order", ok: false }],
    terminal: {
      kind: "finalMessage",
      text:
        "I wasn't able to locate an order matching #9999 on this account. Could you confirm the order number from your confirmation email, along with the name or email used at checkout? Once I have that I can look into the missing package right away.",
    },
  },
  {
    id: seedId(6),
    agent: MP,
    category: "missing_package",
    subject: "Re: Where is my order #1006",
    summary: "Delivered-but-missing for #1006; verify reply drafted, approved by a manager, and sent — case resolved (BRANCH A, full loop).",
    customerEmail: "hannah.kim@example.com",
    customerName: "Hannah Kim",
    orderId: "#1006",
    shopifyOrderId: "1006",
    handoffReason: "Order #1006 shows delivered but customer reports it missing.",
    ageMinutes: 320,
    executedTools: [{ tool: "shopify.get_order" }],
    terminal: {
      kind: "approval",
      resolved: true,
      draftId: "missing-package-reply-1006",
      replyBody:
        "Hi Hannah,\n\nThanks for flagging this. Order #1006 was marked delivered by DHL (tracking JD0099112233) on May 24. Before we treat it as lost, could you check your porch, mailbox, and building entrance, and ask any household members or close neighbors? Please also confirm the address on the order.\n\nIf it's still nowhere to be found, reply here and we'll open a carrier claim and arrange a reshipment or refund.\n\nBest,\nSupport",
    },
  },

  // ===================== DAMAGED PRODUCT AGENT =====================
  {
    id: seedId(7),
    agent: DP,
    category: "damaged_product",
    subject: "My lamp arrived cracked (photos attached)",
    summary: "Photos present, productMatch=match; replacement offered for #2001 (BRANCH A → replacement).",
    customerEmail: "olivia.brooks@example.com",
    customerName: "Olivia Brooks",
    orderId: "#2001",
    shopifyOrderId: "2001",
    handoffReason: "Customer sent photos of a damaged item from order #2001.",
    ageMinutes: 20,
    productMatch: "match",
    photoSignals: { count: 2, withExif: 2, stripped: 0, anyStripped: false },
    executedTools: [
      { tool: "shopify.get_order" },
      { tool: "shopify.get_product" },
      { tool: "case.update_context" },
    ],
    terminal: {
      kind: "approval",
      draftId: "damaged-product-reply-2001",
      replyBody:
        "Hi Olivia,\n\nThank you for the photos — I can clearly see the cracked glass shade on your Aurora Desk Lamp from order #2001, and I'm so sorry it arrived that way.\n\nI'll send you a free replacement right away — please keep or discard the damaged one, no need to ship it back. If you'd rather have a refund instead, just reply and let me know.\n\nBest,\nSupport",
    },
  },
  {
    id: seedId(8),
    agent: DP,
    category: "damaged_product",
    subject: "Customized print torn in shipping — want my money back",
    summary: "Photos present, productMatch=match; refund proposed for one-off custom item on #2002 (BRANCH A → refund).",
    customerEmail: "marcus.lee@example.com",
    customerName: "Marcus Lee",
    orderId: "#2002",
    shopifyOrderId: "2002",
    handoffReason: "Photos of a torn custom print from order #2002; customer asked for a refund.",
    ageMinutes: 47,
    productMatch: "match",
    photoSignals: { count: 1, withExif: 1, stripped: 0, anyStripped: false },
    executedTools: [
      { tool: "shopify.get_order" },
      { tool: "shopify.get_product" },
      { tool: "case.update_context" },
    ],
    terminal: {
      kind: "approval",
      draftId: "damaged-product-reply-2002",
      replyBody:
        "Hi Marcus,\n\nThanks for the photos — the tear across your custom Skyline Print (order #2002) is clearly visible, and I'm really sorry. Since this is a made-to-order piece, a replacement would take some time, so I've arranged a refund of $64.00 to your original payment method — please allow 5-10 business days for it to appear.\n\nIf you'd prefer we reprint it instead, just reply and I'll set that up.\n\nBest,\nSupport",
    },
  },
  {
    id: seedId(9),
    agent: DP,
    category: "damaged_product",
    subject: "Broken item, here's a pic",
    summary: "Photos present but productMatch=mismatch (photo shows a different product than #2003 — fraud signal); reply softened to confirm the item first.",
    customerEmail: "alex.unknown@example.com",
    customerName: "Alex Rivera",
    orderId: "#2003",
    shopifyOrderId: "2003",
    handoffReason: "Photo of a broken item attached for order #2003.",
    ageMinutes: 75,
    priority: "high",
    productMatch: "mismatch",
    photoSignals: { count: 1, withExif: 0, stripped: 1, anyStripped: true },
    // All three fraud signals stack on this case: wrong product, stripped
    // EXIF, and the same photo already seen on another order (#2001).
    riskFlags: [`duplicate_photo_seen_in_case_${seedId(7)}`],
    executedTools: [
      { tool: "shopify.get_order" },
      { tool: "shopify.get_product" },
      { tool: "case.update_context" },
    ],
    terminal: {
      kind: "approval",
      draftId: "damaged-product-reply-2003",
      replyBody:
        "Hi Alex,\n\nThanks for reaching out and for the photo. I want to make sure I'm looking at the right item before I sort out a resolution — the photo doesn't seem to match the Ceramic Vase on order #2003. Could you confirm the order number and which item is the damaged one (a photo of the packing slip or the item alongside the box helps)?\n\nAs soon as I can confirm, I'll get a replacement or refund arranged for you.\n\nBest,\nSupport",
    },
  },
  {
    id: seedId(10),
    agent: DP,
    category: "damaged_product",
    subject: "This came damaged",
    summary: "Photos present but the line item had no product reference (null productId → get_product skipped, productMatch=uncertain); reply softened to confirm the item.",
    customerEmail: "nadia.osei@example.com",
    customerName: "Nadia Osei",
    orderId: "#2004",
    shopifyOrderId: "2004",
    handoffReason: "Damaged-item photo attached for order #2004.",
    ageMinutes: 110,
    productMatch: "uncertain",
    photoSignals: { count: 2, withExif: 1, stripped: 1, anyStripped: true },
    executedTools: [
      { tool: "shopify.get_order" },
      { tool: "case.update_context" },
    ],
    terminal: {
      kind: "approval",
      draftId: "damaged-product-reply-2004",
      replyBody:
        "Hi Nadia,\n\nI'm sorry your order #2004 arrived damaged, and thank you for the photo. I want to be sure I'm matching it to the right item before proposing a fix — could you confirm which product in the order is the damaged one? A quick photo of the packing slip would help too.\n\nOnce confirmed I'll arrange a replacement or refund straight away.\n\nBest,\nSupport",
    },
  },
  {
    id: seedId(11),
    agent: DP,
    category: "damaged_product",
    subject: "Item arrived broken",
    summary: "No photos attached; agent auto-sent a photo request and parked the case waiting for the customer, with a 72h follow-up timer (BRANCH B).",
    customerEmail: "samir.haddad@example.com",
    customerName: "Samir Haddad",
    orderId: "#2005",
    shopifyOrderId: "2005",
    handoffReason: "Customer reports a damaged item on order #2005 with no photos.",
    ageMinutes: 8,
    executedTools: [],
    terminal: {
      kind: "askCustomer",
      withTimer: true,
      draftId: "damaged-product-photo-request-2005",
      body:
        "Hi Samir,\n\nI'm sorry to hear your order #2005 arrived damaged. So I can sort out a replacement or refund quickly, could you reply with a few clear photos showing the damage from at least two angles, plus a photo of the outer packaging if you still have it?\n\nAs soon as I see them I'll propose the best resolution.\n\nBest,\nSupport",
    },
  },
  {
    id: seedId(12),
    agent: DP,
    category: "damaged_product",
    subject: "Re: Mug shattered in the box (photos)",
    summary: "Photos present, productMatch=match; replacement reply drafted, approved by a manager, and sent — case resolved (BRANCH A, full loop).",
    customerEmail: "grace.tan@example.com",
    customerName: "Grace Tan",
    orderId: "#2006",
    shopifyOrderId: "2006",
    handoffReason: "Photos of a shattered mug from order #2006.",
    ageMinutes: 400,
    productMatch: "match",
    photoSignals: { count: 2, withExif: 2, stripped: 0, anyStripped: false },
    executedTools: [
      { tool: "shopify.get_order" },
      { tool: "shopify.get_product" },
      { tool: "case.update_context" },
    ],
    terminal: {
      kind: "approval",
      resolved: true,
      draftId: "damaged-product-reply-2006",
      replyBody:
        "Hi Grace,\n\nThank you for the photos — the Heritage Mug from order #2006 is clearly shattered, and I'm sorry it reached you like that.\n\nI'll send a free replacement right away; no need to return the broken one. If you'd prefer a refund instead, just let me know and I'll switch it over.\n\nBest,\nSupport",
    },
  },
  {
    id: seedId(13),
    agent: DP,
    category: "damaged_product",
    subject: "Damaged order 8888",
    summary: "Order id #8888 could not be located in Shopify; agent ended with a plain-text clarification request (case resolved, no reply sent).",
    customerEmail: "unknown.damaged@example.com",
    customerName: null,
    orderId: "#8888",
    shopifyOrderId: "8888",
    handoffReason: "Customer reports a damaged item on order #8888.",
    ageMinutes: 200,
    executedTools: [{ tool: "shopify.get_order", ok: false }],
    terminal: {
      kind: "finalMessage",
      text:
        "I couldn't find an order matching #8888 on this account. Could you confirm the order number from your confirmation email and the email used at checkout? Once I have that I'll review the damage and get a replacement or refund sorted for you.",
    },
  },

  // ===================== REFUND REVIEW AGENT =====================
  // These are the cases where you "approve a refund" — the pending approval's
  // tool is `refund.create` (risk money → riskLevel high), not a reply.
  {
    id: seedId(14),
    agent: RR,
    category: "refund_request",
    subject: "Please refund my order #3001 — changed my mind",
    summary: "Customer requested a refund on #3001; agent looked up the order, ran a refund recommendation (full), and proposed refund.create — REFUND PENDING YOUR APPROVAL.",
    customerEmail: "ruth.callahan@example.com",
    customerName: "Ruth Callahan",
    orderId: "#3001",
    shopifyOrderId: "3001",
    handoffReason: "Customer asks for a refund on order #3001.",
    ageMinutes: 6,
    priority: "high",
    executedTools: [
      { tool: "shopify.get_order" },
      {
        tool: "refund.recommend",
        output: {
          recommendation: "full_refund",
          amount: { amount: "42.00", currencyCode: "USD" },
          reasoning:
            "Order is paid, unfulfilled, and within the 30-day return window. No prior refunds on this customer. Safe to refund in full.",
          riskFlags: [],
        },
      },
    ],
    terminal: {
      kind: "refundApproval",
      orderGid: "gid://shopify/Order/3001",
      amount: "42.00",
      currencyCode: "USD",
      reason: "Customer changed their mind before fulfillment — full refund per policy.",
      notifyCustomer: true,
    },
  },
  {
    id: seedId(15),
    agent: RR,
    category: "refund_request",
    subject: "Want a partial refund — one item was wrong",
    summary: "Customer requested a partial refund on #3002 (one wrong item); recommendation flagged a repeat-refunder, partial proposed — REFUND PENDING YOUR APPROVAL.",
    customerEmail: "victor.nguyen@example.com",
    customerName: "Victor Nguyen",
    orderId: "#3002",
    shopifyOrderId: "3002",
    handoffReason: "Customer asks for a partial refund on order #3002.",
    ageMinutes: 41,
    executedTools: [
      { tool: "shopify.get_order" },
      {
        tool: "refund.recommend",
        output: {
          recommendation: "partial_refund",
          amount: { amount: "18.50", currencyCode: "USD" },
          reasoning:
            "One of three line items shipped incorrectly; refund that item's value only. Customer has 2 prior refunds in 90 days — operator review recommended.",
          riskFlags: ["repeat_refunder", "partial_only"],
        },
      },
    ],
    terminal: {
      kind: "refundApproval",
      orderGid: "gid://shopify/Order/3002",
      amount: "18.50",
      currencyCode: "USD",
      reason: "Partial refund for the incorrectly shipped line item.",
      notifyCustomer: true,
    },
  },
  {
    id: seedId(16),
    agent: RR,
    category: "refund_request",
    subject: "Re: Refund for defective blender (order #3003)",
    summary: "Refund on #3003 proposed and approved by a manager, then issued — case resolved (refund.create full loop).",
    customerEmail: "lena.petrov@example.com",
    customerName: "Lena Petrov",
    orderId: "#3003",
    shopifyOrderId: "3003",
    handoffReason: "Customer asks for a refund on defective blender, order #3003.",
    ageMinutes: 280,
    executedTools: [
      { tool: "shopify.get_order" },
      {
        tool: "refund.recommend",
        output: {
          recommendation: "full_refund",
          amount: { amount: "89.00", currencyCode: "USD" },
          reasoning:
            "Confirmed defective item, delivered, first refund for this customer. Full refund appropriate.",
          riskFlags: [],
        },
      },
    ],
    terminal: {
      kind: "refundApproval",
      resolved: true,
      orderGid: "gid://shopify/Order/3003",
      amount: "89.00",
      currencyCode: "USD",
      reason: "Defective blender — full refund.",
      notifyCustomer: true,
    },
  },
];

const main = async (): Promise<void> => {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const argv = process.argv.slice(2);
  const tenantId =
    argv.includes("--tenant")
      ? (argv[argv.indexOf("--tenant") + 1] ?? DEFAULT_TENANT)
      : DEFAULT_TENANT;
  const cleanOnly = argv.includes("--clean");

  const ids = scenarios.map((s) => s.id);
  const { db, close } = makeDbClient({ databaseUrl });

  try {
    // Clean up prior mock rows (dependents first; audit_log + timers have no
    // restrict to worry about, approvals references cases without cascade).
    await db.delete(approvals).where(inArray(approvals.caseId, ids));
    await db.delete(timers).where(inArray(timers.caseId, ids));
    await db.delete(auditLog).where(inArray(auditLog.caseId, ids));
    await db.delete(caseStateTransitions).where(inArray(caseStateTransitions.caseId, ids));
    await db.delete(cases).where(inArray(cases.id, ids));
    console.log(`[seed] cleared ${ids.length} prior mock case(s)`);

    if (cleanOnly) {
      console.log("[seed] --clean: done (no re-insert)");
      return;
    }

    const built = scenarios.map((s) => build(tenantId, s));

    await db.insert(cases).values(built.map((b) => b.caseRow));
    await db.insert(caseStateTransitions).values(built.flatMap((b) => b.transitions));
    await db.insert(auditLog).values(built.flatMap((b) => b.audits));
    const allApprovals = built.flatMap((b) => b.approvals);
    if (allApprovals.length > 0) await db.insert(approvals).values(allApprovals);
    const allTimers = built.flatMap((b) => b.timers);
    if (allTimers.length > 0) await db.insert(timers).values(allTimers);

    console.log(`[seed] tenant=${tenantId}`);
    console.log(`[seed] inserted ${built.length} cases:`);
    for (const s of scenarios) {
      const t = s.terminal.kind;
      const outcome =
        t === "approval"
          ? s.terminal.resolved
            ? "resolved (approved & sent)"
            : "waiting_for_approval (reply)"
          : t === "refundApproval"
            ? s.terminal.resolved
              ? "resolved (refund approved & issued)"
              : "waiting_for_approval (REFUND)"
            : t === "askCustomer"
              ? "waiting_for_customer"
              : "resolved (final_message)";
      console.log(`  - [${s.agent}] ${s.orderId} ${s.subject} → ${outcome}`);
    }
  } finally {
    await close();
  }
};

main().catch((err: unknown) => {
  console.error("[seed] fatal:", err);
  process.exit(1);
});
