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
  CaseRepository,
  CaseRepositoryTest,
} from "../src/case-repository.js";
import {
  CaseLifecycleWriter,
  CaseLifecycleWriterLive,
} from "../src/case-lifecycle-writer.js";
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
  CaseRepositoryTest,
  AuditLogServiceTest,
  TransactionRunnerPassthrough,
);

const layer = Layer.provideMerge(CaseLifecycleWriterLive, deps);

const run = <A, E>(
  eff: Effect.Effect<
    A,
    E,
    ApprovalService | CaseRepository | AuditLogService | CaseLifecycleWriter
  >,
) => Effect.runPromise(Effect.provide(eff, layer));

describe("CaseLifecycleWriter", () => {
  it("escalates a waiting supplier case to human takeover with risk flag and audit", async () => {
    const out = await run(
      Effect.gen(function* () {
        const cases = yield* CaseRepository;
        const audit = yield* AuditLogService;
        const lifecycle = yield* CaseLifecycleWriter;
        const created = yield* cases.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("missing-package-agent"),
          status: "waiting_for_supplier",
          context: { riskFlags: ["existing"], source: "supplier-tool" },
        });

        const updated = yield* lifecycle.escalateToHuman({
          caseId: created.id,
          tenantId: TenantId("tenant-a"),
          actor: { type: "system", id: "supplier-notify" },
          reason: "supplier_unreachable",
          riskFlag: "supplier_unreachable",
          onlyFromStatus: "waiting_for_supplier",
          details: { escalationId: "e-cap", supplierEmail: "wh@x.com" },
        });

        const fetched = yield* cases.getById(created.id, TenantId("tenant-a"));
        const entries = yield* audit.forCase(created.id, {
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
      action: "case.escalated_to_human",
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
        const cases = yield* CaseRepository;
        const audit = yield* AuditLogService;
        const lifecycle = yield* CaseLifecycleWriter;
        const created = yield* cases.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("missing-package-agent"),
          status: "in_progress",
          context: {},
        });

        const updated = yield* lifecycle.escalateToHuman({
          caseId: created.id,
          tenantId: TenantId("tenant-a"),
          actor: { type: "system", id: "supplier-notify" },
          reason: "supplier_unreachable",
          riskFlag: "supplier_unreachable",
          onlyFromStatus: "waiting_for_supplier",
          details: { escalationId: "e-cap" },
        });

        const fetched = yield* cases.getById(created.id, TenantId("tenant-a"));
        const entries = yield* audit.forCase(created.id, {
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
        const cases = yield* CaseRepository;
        const audit = yield* AuditLogService;
        const lifecycle = yield* CaseLifecycleWriter;
        const created = yield* cases.create({
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
          caseId: created.id,
          tenantId: TenantId("tenant-a"),
          actor: { type: "system", id: "reply-delivery-retry" },
          reason: "reply delivered on retry",
          bridgeFromHumanTakeover: true,
          clearRiskFlags: ["reply_delivery_failed"],
          details: { reason: "reply_delivered_on_retry" },
        });

        const fetched = yield* cases.getById(created.id, TenantId("tenant-a"));
        const entries = yield* audit.forCase(created.id, {
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
      action: "case.resolved",
      details: { reason: "reply_delivered_on_retry" },
    });
  });

  it("refuses an AGENT resolve on a case with an unverified order/customer mismatch (parks for a human)", async () => {
    const out = await run(
      Effect.gen(function* () {
        const cases = yield* CaseRepository;
        const audit = yield* AuditLogService;
        const lifecycle = yield* CaseLifecycleWriter;
        const created = yield* cases.create({
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
          caseId: created.id,
          tenantId: TenantId("tenant-a"),
          actor: { type: "agent", id: AgentId("order-status-agent") },
          reason: "runtime: final_message",
          details: { turn: 6 },
        });
        const fetched = yield* cases.getById(created.id, TenantId("tenant-a"));
        const entries = yield* audit.forCase(created.id, {
          tenantId: TenantId("tenant-a"),
        });
        return { result, fetched, entries };
      }),
    );

    // The case is NOT resolved — it parked for a human.
    expect(out.result.status).toBe("human_takeover");
    expect(out.fetched.status).toBe("human_takeover");
    expect(out.fetched.resolvedAt).toBeNull();
    const actions = out.entries.map((e) => e.action);
    expect(actions).not.toContain("case.resolved");
    expect(actions).toContain("case.escalated_to_human");
  });

  it("still allows a HUMAN (user) resolve on an unverified-mismatch case", async () => {
    const out = await run(
      Effect.gen(function* () {
        const cases = yield* CaseRepository;
        const lifecycle = yield* CaseLifecycleWriter;
        const created = yield* cases.create({
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
          caseId: created.id,
          tenantId: TenantId("tenant-a"),
          actor: { type: "user", id: "mgr-1" },
          reason: "manager resolved manually",
        });
        return { result };
      }),
    );
    expect(out.result.status).toBe("resolved");
  });

  it("parks a case for approval with approval row, transition, and audit", async () => {
    const out = await run(
      Effect.gen(function* () {
        const approvals = yield* ApprovalService;
        const cases = yield* CaseRepository;
        const audit = yield* AuditLogService;
        const lifecycle = yield* CaseLifecycleWriter;
        const created = yield* cases.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("order-status-agent"),
          status: "in_progress",
        });

        const parked = yield* lifecycle.parkForApproval({
          caseId: created.id,
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
          fetched: yield* cases.getById(created.id, TenantId("tenant-a")),
          entries: yield* audit.forCase(created.id, {
            tenantId: TenantId("tenant-a"),
          }),
        };
      }),
    );

    expect(out.parked.case_.status).toBe("waiting_for_approval");
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
      action: "case.waiting_for_approval",
      details: {
        approvalId: out.approval.id,
        tool: "conversation.reply",
        turn: 2,
      },
    });
  });

  it("parks cases for customer and supplier waits with domain audit rows", async () => {
    const out = await run(
      Effect.gen(function* () {
        const cases = yield* CaseRepository;
        const audit = yield* AuditLogService;
        const lifecycle = yield* CaseLifecycleWriter;
        const customerCase = yield* cases.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("order-status-agent"),
          status: "in_progress",
        });
        const supplierCase = yield* cases.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("missing-package-agent"),
          status: "in_progress",
        });

        const customer = yield* lifecycle.parkWaitingForCustomer({
          caseId: customerCase.id,
          tenantId: TenantId("tenant-a"),
          agentId: AgentId("order-status-agent"),
          tool: "conversation.ask_customer",
          callId: "call-customer",
        });
        const supplier = yield* lifecycle.parkWaitingForSupplier({
          caseId: supplierCase.id,
          tenantId: TenantId("tenant-a"),
          agentId: AgentId("missing-package-agent"),
          tool: "supplier.escalate",
          callId: "call-supplier",
        });

        return {
          customer,
          supplier,
          customerEntries: yield* audit.forCase(customerCase.id, {
            tenantId: TenantId("tenant-a"),
          }),
          supplierEntries: yield* audit.forCase(supplierCase.id, {
            tenantId: TenantId("tenant-a"),
          }),
        };
      }),
    );

    expect(out.customer.status).toBe("waiting_for_customer");
    expect(out.supplier.status).toBe("waiting_for_supplier");
    expect(out.customerEntries[0]).toMatchObject({
      actor: { type: "agent", id: "order-status-agent" },
      action: "case.waiting_for_customer",
      details: { tool: "conversation.ask_customer", callId: "call-customer" },
    });
    expect(out.supplierEntries[0]).toMatchObject({
      actor: { type: "agent", id: "missing-package-agent" },
      action: "case.waiting_for_supplier",
      details: { tool: "supplier.escalate", callId: "call-supplier" },
    });
  });

  it("reopens a resolved case for an inbound customer event", async () => {
    const out = await run(
      Effect.gen(function* () {
        const cases = yield* CaseRepository;
        const audit = yield* AuditLogService;
        const lifecycle = yield* CaseLifecycleWriter;
        const created = yield* cases.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("order-status-agent"),
          status: "resolved",
        });

        const reopened = yield* lifecycle.reopenForCustomerReply({
          caseId: created.id,
          tenantId: TenantId("tenant-a"),
          eventType: "customer.replied",
        });

        return {
          reopened,
          entries: yield* audit.forCase(created.id, {
            tenantId: TenantId("tenant-a"),
          }),
        };
      }),
    );

    expect(out.reopened.status).toBe("in_progress");
    expect(out.entries[0]).toMatchObject({
      actor: { type: "system", id: "runtime" },
      action: "case.reopened",
      details: { eventType: "customer.replied" },
    });
  });

  it("parks reply delivery failures with durable retry data, risk flag, audit, and execution marker", async () => {
    const replyDelivery = makeReplyDeliveryServiceTest();
    const layerWithReplyFailureDeps = Layer.provideMerge(
      CaseLifecycleWriterLive,
      Layer.mergeAll(deps, replyDelivery.layer, ToolExecutionStoreTest),
    );

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const cases = yield* CaseRepository;
          const audit = yield* AuditLogService;
          const executions = yield* ToolExecutionStore;
          const lifecycle = yield* CaseLifecycleWriter;
          const created = yield* cases.create({
            tenantId: TenantId("tenant-a"),
            channel: "email",
            currentAgentId: AgentId("order-status-agent"),
            status: "in_progress",
            mailbox: "support@store.test",
            context: { riskFlags: ["existing"] },
          });

          const parked = yield* lifecycle.parkForReplyDeliveryFailure({
            caseId: created.id,
            tenantId: TenantId("tenant-a"),
            agentId: AgentId("order-status-agent"),
            tool: "conversation.reply",
            draftInput: { draftId: "draft-1", bodyText: "Hi" },
            error: { _tag: "ConnectorUnavailable" },
            executionKey: "exec-1",
          });

          return {
            parked,
            fetched: yield* cases.getById(created.id, TenantId("tenant-a")),
            entries: yield* audit.forCase(created.id, {
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
        caseId: expect.any(String),
        agentId: AgentId("order-status-agent"),
        tool: "conversation.reply",
        mailbox: "support@store.test",
        draftId: "draft-1",
        draft: { draftId: "draft-1", bodyText: "Hi" },
        error: "ConnectorUnavailable",
      },
    ]);
    expect(out.entries[0]).toMatchObject({
      action: "case.escalated_to_human",
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

  it("takes over a non-terminal case, audits it, and cancels pending approvals", async () => {
    const out = await run(
      Effect.gen(function* () {
        const approvals = yield* ApprovalService;
        const cases = yield* CaseRepository;
        const audit = yield* AuditLogService;
        const lifecycle = yield* CaseLifecycleWriter;
        const created = yield* cases.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("refund-review-agent"),
          status: "waiting_for_approval",
        });
        const approval = yield* approvals.create({
          tenantId: TenantId("tenant-a"),
          caseId: created.id,
          agentId: AgentId("refund-review-agent"),
          tool: "conversation.reply",
          proposedInput: { bodyText: "draft" },
          reasoning: "needs review",
          riskLevel: "medium",
          expiresAt: new Date(Date.now() + 86_400_000),
        });

        const result = yield* lifecycle.takeOver({
          caseId: created.id,
          tenantId: TenantId("tenant-a"),
          actor: { type: "user", id: "manager-1" },
          decidedBy: UserId("manager-1"),
          reason: "manual handling",
        });

        const fetched = yield* cases.getById(created.id, TenantId("tenant-a"));
        const decided = yield* approvals.getById(
          approval.id,
          TenantId("tenant-a"),
        );
        const entries = yield* audit.forCase(created.id, {
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
    expect(out.decided.decisionReason).toBe("case taken over");
    expect(out.entries[0]).toMatchObject({
      actor: { type: "user", id: "manager-1" },
      action: "case.taken_over",
      details: {
        reason: "manual handling",
        fromStatus: "waiting_for_approval",
      },
    });
  });

  it("does not take over terminal cases", async () => {
    const out = await run(
      Effect.gen(function* () {
        const cases = yield* CaseRepository;
        const audit = yield* AuditLogService;
        const lifecycle = yield* CaseLifecycleWriter;
        const created = yield* cases.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("support-triage"),
          status: "resolved",
        });

        const result = yield* lifecycle.takeOver({
          caseId: created.id,
          tenantId: TenantId("tenant-a"),
          actor: { type: "user", id: "manager-1" },
          decidedBy: UserId("manager-1"),
          reason: "manual handling",
        });

        const fetched = yield* cases.getById(created.id, TenantId("tenant-a"));
        const entries = yield* audit.forCase(created.id, {
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

  it("resumes only human takeover cases", async () => {
    const out = await run(
      Effect.gen(function* () {
        const cases = yield* CaseRepository;
        const audit = yield* AuditLogService;
        const lifecycle = yield* CaseLifecycleWriter;
        const takeover = yield* cases.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("support-triage"),
          status: "human_takeover",
        });
        const active = yield* cases.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("support-triage"),
          status: "in_progress",
        });

        const resumed = yield* lifecycle.resume({
          caseId: takeover.id,
          tenantId: TenantId("tenant-a"),
          actor: { type: "user", id: "manager-1" },
          reason: "handing back",
        });
        const noOp = yield* lifecycle.resume({
          caseId: active.id,
          tenantId: TenantId("tenant-a"),
          actor: { type: "user", id: "manager-1" },
          reason: "handing back",
        });

        return {
          resumed,
          noOp,
          takeover: yield* cases.getById(takeover.id, TenantId("tenant-a")),
          entries: yield* audit.forCase(takeover.id, {
            tenantId: TenantId("tenant-a"),
          }),
        };
      }),
    );

    expect(out.resumed).toEqual({ kind: "resumed", toStatus: "in_progress" });
    expect(out.takeover.status).toBe("in_progress");
    expect(out.noOp).toEqual({ kind: "not_in_takeover", status: "in_progress" });
    expect(out.entries[0]).toMatchObject({
      action: "case.resumed",
      details: { reason: "handing back", fromStatus: "human_takeover" },
    });
  });

  it("restartFromTriage resume rebinds the case to support-triage and clears the stale classification", async () => {
    const out = await run(
      Effect.gen(function* () {
        const cases = yield* CaseRepository;
        const audit = yield* AuditLogService;
        const lifecycle = yield* CaseLifecycleWriter;
        // A case already routed to a specialist (refund-review) and
        // classified — exactly the shape that won't re-route on a plain
        // resume (the runtime re-runs current_agent_id).
        const takeover = yield* cases.create({
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
          caseId: takeover.id,
          tenantId: TenantId("tenant-a"),
          actor: { type: "user", id: "manager-1" },
          reason: "full retry from triage",
          restartFromTriage: true,
        });

        return {
          resumed,
          after: yield* cases.getById(takeover.id, TenantId("tenant-a")),
          entries: yield* audit.forCase(takeover.id, {
            tenantId: TenantId("tenant-a"),
          }),
        };
      }),
    );

    expect(out.resumed).toEqual({ kind: "resumed", toStatus: "in_progress" });
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
      action: "case.resumed",
      details: { restartFromTriage: true },
    });
  });

  it("sets a merchant status through the state machine and cancels approvals", async () => {
    const out = await run(
      Effect.gen(function* () {
        const approvals = yield* ApprovalService;
        const cases = yield* CaseRepository;
        const audit = yield* AuditLogService;
        const lifecycle = yield* CaseLifecycleWriter;
        const created = yield* cases.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("refund-review-agent"),
          status: "waiting_for_approval",
        });
        const approval = yield* approvals.create({
          tenantId: TenantId("tenant-a"),
          caseId: created.id,
          agentId: AgentId("refund-review-agent"),
          tool: "conversation.reply",
          proposedInput: { bodyText: "draft" },
          reasoning: "needs review",
          riskLevel: "medium",
          expiresAt: new Date(Date.now() + 86_400_000),
        });

        const result = yield* lifecycle.setMerchantStatus({
          caseId: created.id,
          tenantId: TenantId("tenant-a"),
          actor: { type: "user", id: "manager-1" },
          decidedBy: UserId("manager-1"),
          toStatus: "resolved",
          reason: "handled offline",
        });

        return {
          result,
          fetched: yield* cases.getById(created.id, TenantId("tenant-a")),
          approval: yield* approvals.getById(approval.id, TenantId("tenant-a")),
          entries: yield* audit.forCase(created.id, {
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
    expect(out.approval.decisionReason).toBe("case status changed manually");
    expect(out.entries[0]).toMatchObject({
      action: "case.status_changed",
      details: {
        reason: "handled offline",
        fromStatus: "waiting_for_approval",
        toStatus: "resolved",
      },
    });
  });

  it("rejects invalid and illegal merchant status changes before writing", async () => {
    const out = await run(
      Effect.gen(function* () {
        const cases = yield* CaseRepository;
        const audit = yield* AuditLogService;
        const lifecycle = yield* CaseLifecycleWriter;
        const takeover = yield* cases.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("support-triage"),
          status: "human_takeover",
        });

        const invalid = yield* lifecycle.setMerchantStatus({
          caseId: takeover.id,
          tenantId: TenantId("tenant-a"),
          actor: { type: "user", id: "manager-1" },
          decidedBy: UserId("manager-1"),
          toStatus: "triaging",
          reason: "bad target",
        });
        const illegal = yield* lifecycle.setMerchantStatus({
          caseId: takeover.id,
          tenantId: TenantId("tenant-a"),
          actor: { type: "user", id: "manager-1" },
          decidedBy: UserId("manager-1"),
          toStatus: "resolved",
          reason: "forbidden target",
        });

        return {
          invalid,
          illegal,
          fetched: yield* cases.getById(takeover.id, TenantId("tenant-a")),
          entries: yield* audit.forCase(takeover.id, {
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
        const cases = yield* CaseRepository;
        const audit = yield* AuditLogService;
        const lifecycle = yield* CaseLifecycleWriter;
        // A legacy relay case: the connector stamped the Shopify mailer as the
        // customer and never found the order. The status is irrelevant — the
        // manager can correct details at any point.
        const created = yield* cases.create({
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

        const updated = yield* lifecycle.setCaseDetails({
          caseId: created.id,
          tenantId: TenantId("tenant-a"),
          actor: { type: "user", id: UserId("mgr-1") },
          customerEmail: "jane@shopper.com",
          customerName: "Jane Shopper",
          identifiedOrderId: "gid://shopify/Order/12345",
          quotedOrderRef: "#1001",
        });

        const fetched = yield* cases.getById(created.id, TenantId("tenant-a"));
        const entries = yield* audit.forCase(created.id, {
          tenantId: TenantId("tenant-a"),
        });
        return { updated, fetched, entries };
      }),
    );

    // The corrected values overwrite the relay email; untouched keys survive.
    expect(out.fetched.context["customerEmail"]).toBe("jane@shopper.com");
    expect(out.fetched.context["customerName"]).toBe("Jane Shopper");
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
      action: "case.details_edited",
      details: {
        changed: ["customerEmail", "customerName", "identifiedOrderId", "quotedOrderRef"],
      },
    });
  });

  it("patches only the provided fields, leaving other context untouched", async () => {
    const out = await run(
      Effect.gen(function* () {
        const cases = yield* CaseRepository;
        const lifecycle = yield* CaseLifecycleWriter;
        const created = yield* cases.create({
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
        yield* lifecycle.setCaseDetails({
          caseId: created.id,
          tenantId: TenantId("tenant-a"),
          actor: { type: "user", id: UserId("mgr-1") },
          customerEmail: "jane@shopper.com",
        });

        return {
          fetched: yield* cases.getById(created.id, TenantId("tenant-a")),
        };
      }),
    );

    expect(out.fetched.context["customerEmail"]).toBe("jane@shopper.com");
    expect(out.fetched.context["identifiedOrderId"]).toBe(
      "gid://shopify/Order/999",
    );
  });
});
