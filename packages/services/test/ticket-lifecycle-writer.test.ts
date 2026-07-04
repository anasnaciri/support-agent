import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { AgentId, TenantId, UserId } from "@support-agent/agent-core";
import {
  ApprovalService,
  ApprovalServiceTest,
} from "../src/approval-service.js";
import {
  AuditLogService,
  AuditLogServiceTest,
} from "../src/audit-log.js";
import {
  TicketRepository,
  TicketRepositoryTest,
} from "../src/ticket-repository.js";
import {
  TicketLifecycleWriter,
  TicketLifecycleWriterLive,
} from "../src/ticket-lifecycle-writer.js";
import {
  makeReplyDeliveryServiceTest,
  REPLY_DELIVERY_FAILED_FLAG,
} from "../src/reply-delivery.js";
import {
  ToolExecutionStore,
  ToolExecutionStoreTest,
} from "../src/idempotency-store.js";
import { TransactionRunnerPassthrough } from "../src/transaction-runner.js";

const deps = Layer.mergeAll(
  ApprovalServiceTest,
  TicketRepositoryTest,
  AuditLogServiceTest,
  TransactionRunnerPassthrough,
);

const layer = Layer.provideMerge(TicketLifecycleWriterLive, deps);

const run = <A, E>(
  eff: Effect.Effect<
    A,
    E,
    ApprovalService | TicketRepository | AuditLogService | TicketLifecycleWriter
  >,
) => Effect.runPromise(Effect.provide(eff, layer));

describe("TicketLifecycleWriter", () => {
  it("escalates a waiting supplier ticket to human takeover with risk flag and audit", async () => {
    const out = await run(
      Effect.gen(function* () {
        const tickets = yield* TicketRepository;
        const audit = yield* AuditLogService;
        const lifecycle = yield* TicketLifecycleWriter;
        const created = yield* tickets.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("missing-package-agent"),
          status: "waiting_for_supplier",
          context: { riskFlags: ["existing"], source: "supplier-tool" },
        });

        const updated = yield* lifecycle.escalateToHuman({
          ticketId: created.id,
          tenantId: TenantId("tenant-a"),
          actor: { type: "system", id: "supplier-notify" },
          reason: "supplier_unreachable",
          riskFlag: "supplier_unreachable",
          onlyFromStatus: "waiting_for_supplier",
          details: { escalationId: "e-cap", supplierEmail: "wh@x.com" },
        });

        const fetched = yield* tickets.getById(created.id, TenantId("tenant-a"));
        const entries = yield* audit.forTicket(created.id, {
          tenantId: TenantId("tenant-a"),
        });
        return { updated, fetched, entries };
      }),
    );

    expect(out.updated.status).toBe("human_takeover");
    expect(out.fetched.status).toBe("human_takeover");
    expect(out.fetched.context["source"]).toBe("supplier-tool");
    expect(out.fetched.context["riskFlags"]).toEqual([
      "existing",
      "supplier_unreachable",
    ]);
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]).toMatchObject({
      actor: { type: "system", id: "supplier-notify" },
      action: "ticket.escalated_to_human",
      details: {
        reason: "supplier_unreachable",
        escalationId: "e-cap",
        supplierEmail: "wh@x.com",
      },
    });
  });

  it("does not write when the expected source status no longer matches", async () => {
    const out = await run(
      Effect.gen(function* () {
        const tickets = yield* TicketRepository;
        const audit = yield* AuditLogService;
        const lifecycle = yield* TicketLifecycleWriter;
        const created = yield* tickets.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("missing-package-agent"),
          status: "in_progress",
          context: {},
        });

        const updated = yield* lifecycle.escalateToHuman({
          ticketId: created.id,
          tenantId: TenantId("tenant-a"),
          actor: { type: "system", id: "supplier-notify" },
          reason: "supplier_unreachable",
          riskFlag: "supplier_unreachable",
          onlyFromStatus: "waiting_for_supplier",
          details: { escalationId: "e-cap" },
        });

        const fetched = yield* tickets.getById(created.id, TenantId("tenant-a"));
        const entries = yield* audit.forTicket(created.id, {
          tenantId: TenantId("tenant-a"),
        });
        return { updated, fetched, entries };
      }),
    );

    expect(out.updated.status).toBe("in_progress");
    expect(out.fetched.context["riskFlags"]).toBeUndefined();
    expect(out.entries).toEqual([]);
  });

  it("resolves through human takeover and clears selected risk flags", async () => {
    const out = await run(
      Effect.gen(function* () {
        const tickets = yield* TicketRepository;
        const audit = yield* AuditLogService;
        const lifecycle = yield* TicketLifecycleWriter;
        const created = yield* tickets.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("order-status-agent"),
          status: "human_takeover",
          context: {
            riskFlags: ["reply_delivery_failed", "manual_attention"],
            retryDeliveryId: "rd-1",
          },
        });

        const resolved = yield* lifecycle.resolve({
          ticketId: created.id,
          tenantId: TenantId("tenant-a"),
          actor: { type: "system", id: "reply-delivery-retry" },
          reason: "reply delivered on retry",
          bridgeFromHumanTakeover: true,
          clearRiskFlags: ["reply_delivery_failed"],
          details: { reason: "reply_delivered_on_retry" },
        });

        const fetched = yield* tickets.getById(created.id, TenantId("tenant-a"));
        const entries = yield* audit.forTicket(created.id, {
          tenantId: TenantId("tenant-a"),
        });
        return { resolved, fetched, entries };
      }),
    );

    expect(out.resolved.status).toBe("resolved");
    expect(out.fetched.resolvedAt).not.toBeNull();
    expect(out.fetched.context["retryDeliveryId"]).toBe("rd-1");
    expect(out.fetched.context["riskFlags"]).toEqual(["manual_attention"]);
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]).toMatchObject({
      actor: { type: "system", id: "reply-delivery-retry" },
      action: "ticket.resolved",
      details: { reason: "reply_delivered_on_retry" },
    });
  });

  it("refuses an AGENT resolve on a ticket with an unverified order/customer mismatch (parks for a human)", async () => {
    const out = await run(
      Effect.gen(function* () {
        const tickets = yield* TicketRepository;
        const audit = yield* AuditLogService;
        const lifecycle = yield* TicketLifecycleWriter;
        const created = yield* tickets.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("order-status-agent"),
          status: "in_progress",
          context: {
            classification: "where_is_order",
            riskFlags: ["order_customer_mismatch"],
            customerEmail: "sue@example.com",
          },
        });
        const result = yield* lifecycle.resolve({
          ticketId: created.id,
          tenantId: TenantId("tenant-a"),
          actor: { type: "agent", id: AgentId("order-status-agent") },
          reason: "runtime: final_message",
          details: { turn: 6 },
        });
        const fetched = yield* tickets.getById(created.id, TenantId("tenant-a"));
        const entries = yield* audit.forTicket(created.id, {
          tenantId: TenantId("tenant-a"),
        });
        return { result, fetched, entries };
      }),
    );

    // The ticket is NOT resolved — it parked for a human.
    expect(out.result.status).toBe("human_takeover");
    expect(out.fetched.status).toBe("human_takeover");
    expect(out.fetched.resolvedAt).toBeNull();
    const actions = out.entries.map((e) => e.action);
    expect(actions).not.toContain("ticket.resolved");
    expect(actions).toContain("ticket.escalated_to_human");
  });

  it("still allows a HUMAN (user) resolve on an unverified-mismatch ticket", async () => {
    const out = await run(
      Effect.gen(function* () {
        const tickets = yield* TicketRepository;
        const lifecycle = yield* TicketLifecycleWriter;
        const created = yield* tickets.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("order-status-agent"),
          status: "in_progress",
          context: {
            classification: "where_is_order",
            riskFlags: ["order_customer_mismatch"],
            customerEmail: "sue@example.com",
          },
        });
        const result = yield* lifecycle.resolve({
          ticketId: created.id,
          tenantId: TenantId("tenant-a"),
          actor: { type: "user", id: "mgr-1" },
          reason: "manager resolved manually",
        });
        return { result };
      }),
    );
    expect(out.result.status).toBe("resolved");
  });

  it("parks a ticket for approval with approval row, transition, and audit", async () => {
    const out = await run(
      Effect.gen(function* () {
        const approvals = yield* ApprovalService;
        const tickets = yield* TicketRepository;
        const audit = yield* AuditLogService;
        const lifecycle = yield* TicketLifecycleWriter;
        const created = yield* tickets.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("order-status-agent"),
          status: "in_progress",
        });

        const parked = yield* lifecycle.parkForApproval({
          ticketId: created.id,
          tenantId: TenantId("tenant-a"),
          agentId: AgentId("order-status-agent"),
          tool: "conversation.reply",
          proposedInput: { bodyText: "draft" },
          reasoning: "customer-facing reply",
          riskLevel: "medium",
          expiresAt: new Date("2026-06-23T12:00:00.000Z"),
          turn: 2,
        });

        return {
          parked,
          approval: yield* approvals.getById(
            parked.approval.id,
            TenantId("tenant-a"),
          ),
          fetched: yield* tickets.getById(created.id, TenantId("tenant-a")),
          entries: yield* audit.forTicket(created.id, {
            tenantId: TenantId("tenant-a"),
          }),
        };
      }),
    );

    expect(out.parked.ticket_.status).toBe("waiting_for_approval");
    expect(out.approval).toMatchObject({
      agentId: AgentId("order-status-agent"),
      tool: "conversation.reply",
      proposedInput: { bodyText: "draft" },
      reasoning: "customer-facing reply",
      riskLevel: "medium",
      status: "pending",
    });
    expect(out.fetched.status).toBe("waiting_for_approval");
    expect(out.entries[0]).toMatchObject({
      actor: { type: "agent", id: "order-status-agent" },
      action: "ticket.waiting_for_approval",
      details: {
        approvalId: out.approval.id,
        tool: "conversation.reply",
        turn: 2,
      },
    });
  });

  it("parks tickets for customer and supplier waits with domain audit rows", async () => {
    const out = await run(
      Effect.gen(function* () {
        const tickets = yield* TicketRepository;
        const audit = yield* AuditLogService;
        const lifecycle = yield* TicketLifecycleWriter;
        const customerTicket = yield* tickets.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("order-status-agent"),
          status: "in_progress",
        });
        const supplierTicket = yield* tickets.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("missing-package-agent"),
          status: "in_progress",
        });

        const customer = yield* lifecycle.parkWaitingForCustomer({
          ticketId: customerTicket.id,
          tenantId: TenantId("tenant-a"),
          agentId: AgentId("order-status-agent"),
          tool: "conversation.ask_customer",
          callId: "call-customer",
        });
        const supplier = yield* lifecycle.parkWaitingForSupplier({
          ticketId: supplierTicket.id,
          tenantId: TenantId("tenant-a"),
          agentId: AgentId("missing-package-agent"),
          tool: "supplier.escalate",
          callId: "call-supplier",
        });

        return {
          customer,
          supplier,
          customerEntries: yield* audit.forTicket(customerTicket.id, {
            tenantId: TenantId("tenant-a"),
          }),
          supplierEntries: yield* audit.forTicket(supplierTicket.id, {
            tenantId: TenantId("tenant-a"),
          }),
        };
      }),
    );

    expect(out.customer.status).toBe("waiting_for_customer");
    expect(out.supplier.status).toBe("waiting_for_supplier");
    expect(out.customerEntries[0]).toMatchObject({
      actor: { type: "agent", id: "order-status-agent" },
      action: "ticket.waiting_for_customer",
      details: { tool: "conversation.ask_customer", callId: "call-customer" },
    });
    expect(out.supplierEntries[0]).toMatchObject({
      actor: { type: "agent", id: "missing-package-agent" },
      action: "ticket.waiting_for_supplier",
      details: { tool: "supplier.escalate", callId: "call-supplier" },
    });
  });

  it("manually parks a live ticket for a supplier with a user-actor audit row", async () => {
    const out = await run(
      Effect.gen(function* () {
        const tickets = yield* TicketRepository;
        const audit = yield* AuditLogService;
        const lifecycle = yield* TicketLifecycleWriter;
        const created = yield* tickets.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("missing-package-agent"),
          status: "in_progress",
        });

        const outcome = yield* lifecycle.parkWaitingForSupplierManually({
          ticketId: created.id,
          tenantId: TenantId("tenant-a"),
          actor: { type: "user", id: "manager-1" },
          reason: "escalated to supplier from dashboard",
          escalationId: "esc-1",
        });

        return {
          outcome,
          fetched: yield* tickets.getById(created.id, TenantId("tenant-a")),
          entries: yield* audit.forTicket(created.id, {
            tenantId: TenantId("tenant-a"),
          }),
        };
      }),
    );

    expect(out.outcome).toEqual({
      kind: "parked",
      toStatus: "waiting_for_supplier",
    });
    expect(out.fetched.status).toBe("waiting_for_supplier");
    expect(out.entries[0]).toMatchObject({
      actor: { type: "user", id: "manager-1" },
      action: "ticket.waiting_for_supplier",
      details: { escalationId: "esc-1" },
    });
  });

  it("manual supplier park bridges from human takeover (never a direct jump)", async () => {
    const out = await run(
      Effect.gen(function* () {
        const tickets = yield* TicketRepository;
        const lifecycle = yield* TicketLifecycleWriter;
        const created = yield* tickets.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("missing-package-agent"),
          status: "human_takeover",
        });

        const outcome = yield* lifecycle.parkWaitingForSupplierManually({
          ticketId: created.id,
          tenantId: TenantId("tenant-a"),
          actor: { type: "user", id: "manager-1" },
          reason: "escalated to supplier from dashboard",
          escalationId: "esc-2",
        });

        return {
          outcome,
          fetched: yield* tickets.getById(created.id, TenantId("tenant-a")),
        };
      }),
    );

    expect(out.outcome).toEqual({
      kind: "parked",
      toStatus: "waiting_for_supplier",
    });
    expect(out.fetched.status).toBe("waiting_for_supplier");
  });

  it("manual supplier park keeps waiting_for_approval as the primary wait", async () => {
    const out = await run(
      Effect.gen(function* () {
        const tickets = yield* TicketRepository;
        const audit = yield* AuditLogService;
        const lifecycle = yield* TicketLifecycleWriter;
        const created = yield* tickets.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("refund-review-agent"),
          status: "waiting_for_approval",
        });

        const outcome = yield* lifecycle.parkWaitingForSupplierManually({
          ticketId: created.id,
          tenantId: TenantId("tenant-a"),
          actor: { type: "user", id: "manager-1" },
          reason: "escalated to supplier from dashboard",
          escalationId: "esc-3",
        });

        return {
          outcome,
          fetched: yield* tickets.getById(created.id, TenantId("tenant-a")),
          entries: yield* audit.forTicket(created.id, {
            tenantId: TenantId("tenant-a"),
          }),
        };
      }),
    );

    // Approval wins the single primary status under concurrent waits; the open
    // escalation row carries the supplier wait on its own. Audit still records
    // the escalation.
    expect(out.outcome).toEqual({
      kind: "parked",
      toStatus: "waiting_for_approval",
    });
    expect(out.fetched.status).toBe("waiting_for_approval");
    expect(out.entries[0]).toMatchObject({
      action: "ticket.waiting_for_supplier",
      details: { escalationId: "esc-3" },
    });
  });

  it("manual supplier park refuses an illegal transition without writing", async () => {
    const out = await run(
      Effect.gen(function* () {
        const tickets = yield* TicketRepository;
        const audit = yield* AuditLogService;
        const lifecycle = yield* TicketLifecycleWriter;
        const created = yield* tickets.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("missing-package-agent"),
          status: "failed",
        });

        const outcome = yield* lifecycle.parkWaitingForSupplierManually({
          ticketId: created.id,
          tenantId: TenantId("tenant-a"),
          actor: { type: "user", id: "manager-1" },
          reason: "escalated to supplier from dashboard",
          escalationId: "esc-4",
        });

        return {
          outcome,
          fetched: yield* tickets.getById(created.id, TenantId("tenant-a")),
          entries: yield* audit.forTicket(created.id, {
            tenantId: TenantId("tenant-a"),
          }),
        };
      }),
    );

    expect(out.outcome).toEqual({
      kind: "transition_not_allowed",
      fromStatus: "failed",
    });
    expect(out.fetched.status).toBe("failed");
    expect(out.entries).toHaveLength(0);
  });

  it("reopens a resolved ticket for an inbound customer event", async () => {
    const out = await run(
      Effect.gen(function* () {
        const tickets = yield* TicketRepository;
        const audit = yield* AuditLogService;
        const lifecycle = yield* TicketLifecycleWriter;
        const created = yield* tickets.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("order-status-agent"),
          status: "resolved",
        });

        const reopened = yield* lifecycle.reopenForCustomerReply({
          ticketId: created.id,
          tenantId: TenantId("tenant-a"),
          eventType: "customer.replied",
        });

        return {
          reopened,
          entries: yield* audit.forTicket(created.id, {
            tenantId: TenantId("tenant-a"),
          }),
        };
      }),
    );

    expect(out.reopened.status).toBe("in_progress");
    expect(out.entries[0]).toMatchObject({
      actor: { type: "system", id: "runtime" },
      action: "ticket.reopened",
      details: { eventType: "customer.replied" },
    });
  });

  it("parks reply delivery failures with durable retry data, risk flag, audit, and execution marker", async () => {
    const replyDelivery = makeReplyDeliveryServiceTest();
    const layerWithReplyFailureDeps = Layer.provideMerge(
      TicketLifecycleWriterLive,
      Layer.mergeAll(deps, replyDelivery.layer, ToolExecutionStoreTest),
    );

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const tickets = yield* TicketRepository;
          const audit = yield* AuditLogService;
          const executions = yield* ToolExecutionStore;
          const lifecycle = yield* TicketLifecycleWriter;
          const created = yield* tickets.create({
            tenantId: TenantId("tenant-a"),
            channel: "email",
            currentAgentId: AgentId("order-status-agent"),
            status: "in_progress",
            mailbox: "support@store.test",
            context: { riskFlags: ["existing"] },
          });

          const parked = yield* lifecycle.parkForReplyDeliveryFailure({
            ticketId: created.id,
            tenantId: TenantId("tenant-a"),
            agentId: AgentId("order-status-agent"),
            tool: "conversation.reply",
            draftInput: { draftId: "draft-1", bodyText: "Hi" },
            error: { _tag: "ConnectorUnavailable" },
            executionKey: "exec-1",
          });

          return {
            parked,
            fetched: yield* tickets.getById(created.id, TenantId("tenant-a")),
            entries: yield* audit.forTicket(created.id, {
              tenantId: TenantId("tenant-a"),
            }),
            marker: yield* executions.find(created.id, "exec-1"),
          };
        }),
        layerWithReplyFailureDeps,
      ) as Effect.Effect<
        {
          readonly parked: { readonly status: string };
          readonly fetched: {
            readonly status: string;
            readonly context: Readonly<Record<string, unknown>>;
          };
          readonly entries: ReadonlyArray<{
            readonly action: string;
            readonly details: Readonly<Record<string, unknown>>;
          }>;
          readonly marker: {
            readonly tool: string;
            readonly resultOk: boolean | null;
          } | null;
        },
        never,
        never
      >,
    );

    expect(out.parked.status).toBe("human_takeover");
    expect(out.fetched.context["riskFlags"]).toEqual([
      "existing",
      REPLY_DELIVERY_FAILED_FLAG,
    ]);
    expect(replyDelivery.handle.enqueued).toEqual([
      {
        tenantId: TenantId("tenant-a"),
        ticketId: expect.any(String),
        agentId: AgentId("order-status-agent"),
        tool: "conversation.reply",
        mailbox: "support@store.test",
        draftId: "draft-1",
        draft: { draftId: "draft-1", bodyText: "Hi" },
        error: "ConnectorUnavailable",
      },
    ]);
    expect(out.entries[0]).toMatchObject({
      action: "ticket.escalated_to_human",
      details: {
        reason: REPLY_DELIVERY_FAILED_FLAG,
        tool: "conversation.reply",
        error: "ConnectorUnavailable",
      },
    });
    expect(out.marker).toMatchObject({
      tool: "conversation.reply",
      resultOk: false,
    });
  });

  it("takes over a non-terminal ticket, audits it, and cancels pending approvals", async () => {
    const out = await run(
      Effect.gen(function* () {
        const approvals = yield* ApprovalService;
        const tickets = yield* TicketRepository;
        const audit = yield* AuditLogService;
        const lifecycle = yield* TicketLifecycleWriter;
        const created = yield* tickets.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("refund-review-agent"),
          status: "waiting_for_approval",
        });
        const approval = yield* approvals.create({
          tenantId: TenantId("tenant-a"),
          ticketId: created.id,
          agentId: AgentId("refund-review-agent"),
          tool: "conversation.reply",
          proposedInput: { bodyText: "draft" },
          reasoning: "needs review",
          riskLevel: "medium",
          expiresAt: new Date(Date.now() + 86_400_000),
        });

        const result = yield* lifecycle.takeOver({
          ticketId: created.id,
          tenantId: TenantId("tenant-a"),
          actor: { type: "user", id: "manager-1" },
          decidedBy: UserId("manager-1"),
          reason: "manual handling",
        });

        const fetched = yield* tickets.getById(created.id, TenantId("tenant-a"));
        const decided = yield* approvals.getById(
          approval.id,
          TenantId("tenant-a"),
        );
        const entries = yield* audit.forTicket(created.id, {
          tenantId: TenantId("tenant-a"),
        });
        return { result, fetched, decided, entries };
      }),
    );

    expect(out.result).toEqual({
      kind: "taken_over",
      canceledApprovals: 1,
    });
    expect(out.fetched.status).toBe("human_takeover");
    expect(out.decided.status).toBe("rejected");
    expect(out.decided.decisionReason).toBe("ticket taken over");
    expect(out.entries[0]).toMatchObject({
      actor: { type: "user", id: "manager-1" },
      action: "ticket.taken_over",
      details: {
        reason: "manual handling",
        fromStatus: "waiting_for_approval",
      },
    });
  });

  it("does not take over terminal tickets", async () => {
    const out = await run(
      Effect.gen(function* () {
        const tickets = yield* TicketRepository;
        const audit = yield* AuditLogService;
        const lifecycle = yield* TicketLifecycleWriter;
        const created = yield* tickets.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("support-triage"),
          status: "resolved",
        });

        const result = yield* lifecycle.takeOver({
          ticketId: created.id,
          tenantId: TenantId("tenant-a"),
          actor: { type: "user", id: "manager-1" },
          decidedBy: UserId("manager-1"),
          reason: "manual handling",
        });

        const fetched = yield* tickets.getById(created.id, TenantId("tenant-a"));
        const entries = yield* audit.forTicket(created.id, {
          tenantId: TenantId("tenant-a"),
        });
        return { result, fetched, entries };
      }),
    );

    expect(out.result).toEqual({
      kind: "already_terminal",
      status: "resolved",
    });
    expect(out.fetched.status).toBe("resolved");
    expect(out.entries).toEqual([]);
  });

  it("resumes only human takeover tickets", async () => {
    const out = await run(
      Effect.gen(function* () {
        const approvals = yield* ApprovalService;
        const tickets = yield* TicketRepository;
        const audit = yield* AuditLogService;
        const lifecycle = yield* TicketLifecycleWriter;
        const takeover = yield* tickets.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("support-triage"),
          status: "human_takeover",
        });
        // A plain hand-back re-runs the SAME bound specialist, so a pending
        // approval it queued is still valid and must survive (only a
        // restart-from-triage re-routes and drops it).
        const approval = yield* approvals.create({
          tenantId: TenantId("tenant-a"),
          ticketId: takeover.id,
          agentId: AgentId("support-triage"),
          tool: "conversation.reply",
          proposedInput: { bodyText: "draft" },
          reasoning: "needs review",
          riskLevel: "medium",
          expiresAt: new Date(Date.now() + 86_400_000),
        });
        const active = yield* tickets.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("support-triage"),
          status: "in_progress",
        });

        const resumed = yield* lifecycle.resume({
          ticketId: takeover.id,
          tenantId: TenantId("tenant-a"),
          actor: { type: "user", id: "manager-1" },
          decidedBy: UserId("manager-1"),
          reason: "handing back",
        });
        const noOp = yield* lifecycle.resume({
          ticketId: active.id,
          tenantId: TenantId("tenant-a"),
          actor: { type: "user", id: "manager-1" },
          decidedBy: UserId("manager-1"),
          reason: "handing back",
        });

        return {
          resumed,
          noOp,
          takeover: yield* tickets.getById(takeover.id, TenantId("tenant-a")),
          stillPending: yield* approvals.getById(
            approval.id,
            TenantId("tenant-a"),
          ),
          entries: yield* audit.forTicket(takeover.id, {
            tenantId: TenantId("tenant-a"),
          }),
        };
      }),
    );

    expect(out.resumed).toEqual({
      kind: "resumed",
      toStatus: "in_progress",
      canceledApprovals: 0,
    });
    expect(out.takeover.status).toBe("in_progress");
    // Plain hand-back leaves the specialist's pending approval untouched.
    expect(out.stillPending.status).toBe("pending");
    expect(out.noOp).toEqual({ kind: "not_in_takeover", status: "in_progress" });
    expect(out.entries[0]).toMatchObject({
      action: "ticket.resumed",
      details: { reason: "handing back", fromStatus: "human_takeover" },
    });
  });

  it("resume bumps the ticket round (epoch) on both hand-back and restart-from-triage", async () => {
    // Recovery hardening: every new attempt owns a fresh round so leftovers of
    // the prior attempt (approvals/events at a lower epoch) are fenced out.
    const out = await run(
      Effect.gen(function* () {
        const tickets = yield* TicketRepository;
        const lifecycle = yield* TicketLifecycleWriter;
        const tenant = TenantId("tenant-a");
        const plain = yield* tickets.create({
          tenantId: tenant,
          channel: "email",
          currentAgentId: AgentId("support-triage"),
          status: "human_takeover",
        });
        yield* lifecycle.resume({
          ticketId: plain.id,
          tenantId: tenant,
          actor: { type: "user", id: "m" },
          decidedBy: UserId("m"),
          reason: "hand back",
        });
        const restart = yield* tickets.create({
          tenantId: tenant,
          channel: "email",
          currentAgentId: AgentId("refund-review-agent"),
          status: "human_takeover",
          context: { classification: "refund" },
        });
        yield* lifecycle.resume({
          ticketId: restart.id,
          tenantId: tenant,
          actor: { type: "user", id: "m" },
          decidedBy: UserId("m"),
          reason: "retry",
          restartFromTriage: true,
        });
        return {
          plainStart: plain.epoch ?? 0,
          plainEpoch: (yield* tickets.getById(plain.id, tenant)).epoch ?? 0,
          restartEpoch: (yield* tickets.getById(restart.id, tenant)).epoch ?? 0,
        };
      }),
    );
    expect(out.plainStart).toBe(0);
    expect(out.plainEpoch).toBe(1);
    expect(out.restartEpoch).toBe(1);
  });

  it("parkForApproval stamps the approval with the ticket's current round", async () => {
    const out = await run(
      Effect.gen(function* () {
        const tickets = yield* TicketRepository;
        const approvals = yield* ApprovalService;
        const lifecycle = yield* TicketLifecycleWriter;
        const tenant = TenantId("tenant-a");
        const c = yield* tickets.create({
          tenantId: tenant,
          channel: "email",
          currentAgentId: AgentId("refund-review-agent"),
          status: "in_progress",
        });
        yield* tickets.update(c.id, { epoch: 3 }, tenant);
        const parked = yield* lifecycle.parkForApproval({
          ticketId: c.id,
          tenantId: tenant,
          agentId: AgentId("refund-review-agent"),
          tool: "conversation.reply",
          proposedInput: { bodyText: "draft" },
          reasoning: "reply",
          riskLevel: "medium",
          expiresAt: new Date(Date.now() + 60_000),
          turn: 1,
        });
        return {
          epoch: (yield* approvals.getById(parked.approval.id, tenant)).epoch ?? 0,
        };
      }),
    );
    expect(out.epoch).toBe(3);
  });

  it("restartFromTriage resume rebinds the ticket to support-triage and clears the stale classification", async () => {
    const out = await run(
      Effect.gen(function* () {
        const tickets = yield* TicketRepository;
        const audit = yield* AuditLogService;
        const lifecycle = yield* TicketLifecycleWriter;
        // A ticket already routed to a specialist (refund-review) and
        // classified — exactly the shape that won't re-route on a plain
        // resume (the runtime re-runs current_agent_id).
        const takeover = yield* tickets.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("refund-review-agent"),
          status: "human_takeover",
          context: {
            classification: "refund_request",
            notes: "courier won't deliver; wants a refund",
            customerEmail: "c@example.com",
          } as never,
        });

        const resumed = yield* lifecycle.resume({
          ticketId: takeover.id,
          tenantId: TenantId("tenant-a"),
          actor: { type: "user", id: "manager-1" },
          decidedBy: UserId("manager-1"),
          reason: "full retry from triage",
          restartFromTriage: true,
        });

        return {
          resumed,
          after: yield* tickets.getById(takeover.id, TenantId("tenant-a")),
          entries: yield* audit.forTicket(takeover.id, {
            tenantId: TenantId("tenant-a"),
          }),
        };
      }),
    );

    expect(out.resumed).toEqual({
      kind: "resumed",
      toStatus: "in_progress",
      canceledApprovals: 0,
    });
    expect(out.after.status).toBe("in_progress");
    // Rebound to triage so the next tick re-classifies + re-routes.
    expect(out.after.currentAgentId).toBe("support-triage");
    // Stale routing key cleared so triage re-derives it...
    expect(out.after.context["classification"]).toBeUndefined();
    // ...but enrichment + the customer's reason are preserved (triage has
    // no message-replay, so it re-classifies from notes).
    expect(out.after.context["notes"]).toBe(
      "courier won't deliver; wants a refund",
    );
    expect(out.after.context["customerEmail"]).toBe("c@example.com");
    expect(out.entries[0]).toMatchObject({
      action: "ticket.resumed",
      details: { restartFromTriage: true },
    });
  });

  it("restartFromTriage resume drops every pending approval", async () => {
    const out = await run(
      Effect.gen(function* () {
        const approvals = yield* ApprovalService;
        const tickets = yield* TicketRepository;
        const lifecycle = yield* TicketLifecycleWriter;
        // A human_takeover ticket still carrying a stale draft the specialist
        // queued before the manager stepped in. Re-triaging re-classifies and
        // re-routes from scratch, so that draft is stale and must be dropped —
        // else a stale approval-link click could act on the old proposal after
        // the ticket has been sent back through triage.
        const takeover = yield* tickets.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("refund-review-agent"),
          status: "human_takeover",
          context: { classification: "refund_request" } as never,
        });
        const approval = yield* approvals.create({
          tenantId: TenantId("tenant-a"),
          ticketId: takeover.id,
          agentId: AgentId("refund-review-agent"),
          tool: "conversation.reply",
          proposedInput: { bodyText: "stale draft" },
          reasoning: "needs review",
          riskLevel: "medium",
          expiresAt: new Date(Date.now() + 86_400_000),
        });

        const resumed = yield* lifecycle.resume({
          ticketId: takeover.id,
          tenantId: TenantId("tenant-a"),
          actor: { type: "user", id: "manager-1" },
          decidedBy: UserId("manager-1"),
          reason: "full retry from triage",
          restartFromTriage: true,
        });

        return {
          resumed,
          decided: yield* approvals.getById(approval.id, TenantId("tenant-a")),
        };
      }),
    );

    expect(out.resumed).toEqual({
      kind: "resumed",
      toStatus: "in_progress",
      canceledApprovals: 1,
    });
    expect(out.decided.status).toBe("rejected");
    expect(out.decided.decisionReason).toBe("ticket restarted from triage");
  });

  it("sets a merchant status through the state machine and cancels approvals", async () => {
    const out = await run(
      Effect.gen(function* () {
        const approvals = yield* ApprovalService;
        const tickets = yield* TicketRepository;
        const audit = yield* AuditLogService;
        const lifecycle = yield* TicketLifecycleWriter;
        const created = yield* tickets.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("refund-review-agent"),
          status: "waiting_for_approval",
        });
        const approval = yield* approvals.create({
          tenantId: TenantId("tenant-a"),
          ticketId: created.id,
          agentId: AgentId("refund-review-agent"),
          tool: "conversation.reply",
          proposedInput: { bodyText: "draft" },
          reasoning: "needs review",
          riskLevel: "medium",
          expiresAt: new Date(Date.now() + 86_400_000),
        });

        const result = yield* lifecycle.setMerchantStatus({
          ticketId: created.id,
          tenantId: TenantId("tenant-a"),
          actor: { type: "user", id: "manager-1" },
          decidedBy: UserId("manager-1"),
          toStatus: "resolved",
          reason: "handled offline",
        });

        return {
          result,
          fetched: yield* tickets.getById(created.id, TenantId("tenant-a")),
          approval: yield* approvals.getById(approval.id, TenantId("tenant-a")),
          entries: yield* audit.forTicket(created.id, {
            tenantId: TenantId("tenant-a"),
          }),
        };
      }),
    );

    expect(out.result).toEqual({
      kind: "updated",
      fromStatus: "waiting_for_approval",
      toStatus: "resolved",
      canceledApprovals: 1,
    });
    expect(out.fetched.status).toBe("resolved");
    expect(out.fetched.resolvedAt).not.toBeNull();
    expect(out.approval.status).toBe("rejected");
    expect(out.approval.decisionReason).toBe("ticket status changed manually");
    expect(out.entries[0]).toMatchObject({
      action: "ticket.status_changed",
      details: {
        reason: "handled offline",
        fromStatus: "waiting_for_approval",
        toStatus: "resolved",
      },
    });
  });

  it("archives a resolved ticket on demand but never a live one", async () => {
    const out = await run(
      Effect.gen(function* () {
        const tickets = yield* TicketRepository;
        const audit = yield* AuditLogService;
        const lifecycle = yield* TicketLifecycleWriter;
        const resolved = yield* tickets.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("support-triage"),
          status: "resolved",
        });
        const live = yield* tickets.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("support-triage"),
          status: "in_progress",
        });

        const archived = yield* lifecycle.setMerchantStatus({
          ticketId: resolved.id,
          tenantId: TenantId("tenant-a"),
          actor: { type: "user", id: "manager-1" },
          decidedBy: UserId("manager-1"),
          toStatus: "archived",
          reason: "archive now",
        });
        const refused = yield* lifecycle.setMerchantStatus({
          ticketId: live.id,
          tenantId: TenantId("tenant-a"),
          actor: { type: "user", id: "manager-1" },
          decidedBy: UserId("manager-1"),
          toStatus: "archived",
          reason: "too early",
        });

        return {
          archived,
          refused,
          fetched: yield* tickets.getById(resolved.id, TenantId("tenant-a")),
          liveFetched: yield* tickets.getById(live.id, TenantId("tenant-a")),
          entries: yield* audit.forTicket(resolved.id, {
            tenantId: TenantId("tenant-a"),
          }),
        };
      }),
    );

    expect(out.archived).toEqual({
      kind: "updated",
      fromStatus: "resolved",
      toStatus: "archived",
      canceledApprovals: 0,
    });
    expect(out.fetched.status).toBe("archived");
    expect(out.fetched.archivedAt).not.toBeNull();
    expect(out.refused).toEqual({
      kind: "transition_not_allowed",
      fromStatus: "in_progress",
      toStatus: "archived",
    });
    expect(out.liveFetched.status).toBe("in_progress");
    expect(out.entries[0]).toMatchObject({
      action: "ticket.status_changed",
      details: { fromStatus: "resolved", toStatus: "archived" },
    });
  });

  it("rejects invalid and illegal merchant status changes before writing", async () => {
    const out = await run(
      Effect.gen(function* () {
        const tickets = yield* TicketRepository;
        const audit = yield* AuditLogService;
        const lifecycle = yield* TicketLifecycleWriter;
        const takeover = yield* tickets.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("support-triage"),
          status: "human_takeover",
        });

        const invalid = yield* lifecycle.setMerchantStatus({
          ticketId: takeover.id,
          tenantId: TenantId("tenant-a"),
          actor: { type: "user", id: "manager-1" },
          decidedBy: UserId("manager-1"),
          toStatus: "triaging",
          reason: "bad target",
        });
        const illegal = yield* lifecycle.setMerchantStatus({
          ticketId: takeover.id,
          tenantId: TenantId("tenant-a"),
          actor: { type: "user", id: "manager-1" },
          decidedBy: UserId("manager-1"),
          toStatus: "resolved",
          reason: "forbidden target",
        });

        return {
          invalid,
          illegal,
          fetched: yield* tickets.getById(takeover.id, TenantId("tenant-a")),
          entries: yield* audit.forTicket(takeover.id, {
            tenantId: TenantId("tenant-a"),
          }),
        };
      }),
    );

    expect(out.invalid).toEqual({ kind: "invalid_status", status: "triaging" });
    expect(out.illegal).toEqual({
      kind: "transition_not_allowed",
      fromStatus: "human_takeover",
      toStatus: "resolved",
    });
    expect(out.fetched.status).toBe("human_takeover");
    expect(out.entries).toEqual([]);
  });

  it("merges manually-assigned customer + order details into context and audits the edit", async () => {
    const out = await run(
      Effect.gen(function* () {
        const tickets = yield* TicketRepository;
        const audit = yield* AuditLogService;
        const lifecycle = yield* TicketLifecycleWriter;
        // A legacy relay ticket: the connector stamped the Shopify mailer as the
        // customer and never found the order. The status is irrelevant — the
        // manager can correct details at any point.
        const created = yield* tickets.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("order-status-agent"),
          status: "human_takeover",
          context: {
            customerEmail: "mailer@shopify.com",
            classification: "where_is_order",
            riskFlags: ["existing"],
          },
        });

        const updated = yield* lifecycle.setTicketDetails({
          ticketId: created.id,
          tenantId: TenantId("tenant-a"),
          actor: { type: "user", id: UserId("mgr-1") },
          customerEmail: "jane@shopper.com",
          customerName: "Jane Shopper",
          customerPhone: "+15551234567",
          identifiedOrderId: "gid://shopify/Order/12345",
          quotedOrderRef: "#1001",
        });

        const fetched = yield* tickets.getById(created.id, TenantId("tenant-a"));
        const entries = yield* audit.forTicket(created.id, {
          tenantId: TenantId("tenant-a"),
        });
        return { updated, fetched, entries };
      }),
    );

    // The corrected values overwrite the relay email; untouched keys survive.
    expect(out.fetched.context["customerEmail"]).toBe("jane@shopper.com");
    expect(out.fetched.context["customerName"]).toBe("Jane Shopper");
    expect(out.fetched.context["customerPhone"]).toBe("+15551234567");
    expect(out.fetched.context["identifiedOrderId"]).toBe(
      "gid://shopify/Order/12345",
    );
    expect(out.fetched.context["quotedOrderRef"]).toBe("#1001");
    expect(out.fetched.context["classification"]).toBe("where_is_order");
    expect(out.fetched.context["riskFlags"]).toEqual(["existing"]);
    // Status is untouched by a details edit.
    expect(out.fetched.status).toBe("human_takeover");
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]).toMatchObject({
      actor: { type: "user", id: "mgr-1" },
      action: "ticket.details_edited",
      details: {
        changed: [
          "customerEmail",
          "customerName",
          "customerPhone",
          "identifiedOrderId",
          "quotedOrderRef",
        ],
      },
    });
  });

  it("patches only the provided fields, leaving other context untouched", async () => {
    const out = await run(
      Effect.gen(function* () {
        const tickets = yield* TicketRepository;
        const lifecycle = yield* TicketLifecycleWriter;
        const created = yield* tickets.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("order-status-agent"),
          status: "in_progress",
          context: {
            customerEmail: "mailer@shopify.com",
            identifiedOrderId: "gid://shopify/Order/999",
          },
        });

        // Only the customer is corrected here — the existing order binding
        // must not be disturbed.
        yield* lifecycle.setTicketDetails({
          ticketId: created.id,
          tenantId: TenantId("tenant-a"),
          actor: { type: "user", id: UserId("mgr-1") },
          customerEmail: "jane@shopper.com",
        });

        return {
          fetched: yield* tickets.getById(created.id, TenantId("tenant-a")),
        };
      }),
    );

    expect(out.fetched.context["customerEmail"]).toBe("jane@shopper.com");
    expect(out.fetched.context["identifiedOrderId"]).toBe(
      "gid://shopify/Order/999",
    );
  });
});
