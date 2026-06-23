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
});
