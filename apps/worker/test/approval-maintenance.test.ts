import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentId,
  TenantId,
  UserId,
  type DomainEvent,
} from "@support-agent/agent-core";
import {
  ApprovalService,
  ApprovalServiceTest,
  AuditLogService,
  AuditLogServiceTest,
  CaseLifecycleWriterLive,
  CaseRepository,
  CaseRepositoryTest,
  TransactionRunnerPassthrough,
} from "@support-agent/services";
import { runApprovalMaintenanceOnce } from "../src/approval-maintenance-schedule.js";

// Audit L7 (sweep half) + L3b — approvals maintenance:
//   - pending approvals past expiresAt flip to expired and their case
//     escalates to a human (previously the `expired` status was
//     unreachable and the case waited forever)
//   - decided approvals whose case never resumed (the workflow event was
//     lost between decision-commit and publish) are re-published

const deps = Layer.mergeAll(
  ApprovalServiceTest,
  CaseRepositoryTest,
  AuditLogServiceTest,
  TransactionRunnerPassthrough,
);

const layer = Layer.provideMerge(CaseLifecycleWriterLive, deps);

const tenantId = TenantId("tenant-acme");

const setupCase = Effect.gen(function* () {
  const repo = yield* CaseRepository;
  const created = yield* repo.create({
    tenantId,
    channel: "email",
    currentAgentId: AgentId("support-triage"),
    subject: "Maintenance test",
  });
  yield* repo.transitionStatus(created.id, "waiting_for_approval", {
    reason: "test setup",
  });
  return created;
});

describe("runApprovalMaintenanceOnce", () => {
  it("expires overdue pending approvals and escalates their case (audit L7)", async () => {
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* CaseRepository;
          const approvals = yield* ApprovalService;
          const audit = yield* AuditLogService;
          const row = yield* setupCase;
          yield* approvals.create({
            tenantId,
            caseId: row.id,
            agentId: AgentId("refund-review-agent"),
            tool: "conversation.reply",
            proposedInput: {},
            reasoning: "test",
            riskLevel: "medium",
            expiresAt: new Date(Date.now() - 60_000),
          });
          const published: DomainEvent[] = [];
          const result = yield* runApprovalMaintenanceOnce({
            publish: (e) => {
              published.push(e);
              return Promise.resolve();
            },
            now: new Date(),
          });
          const fetched = yield* repo.getById(row.id);
          const entries = yield* audit.forCase(row.id);
          return { result, fetched, entries, published };
        }),
        layer,
      ) as Effect.Effect<
        {
          result: { expired: number; republished: number };
          fetched: { status: string };
          entries: ReadonlyArray<{ action: string }>;
          published: ReadonlyArray<DomainEvent>;
        },
        never,
        never
      >,
    );

    expect(out.result.expired).toBe(1);
    expect(out.fetched.status).toBe("human_takeover");
    expect(out.entries.map((e) => e.action)).toContain(
      "case.escalated_to_human",
    );
    // Expiry does not publish decision events.
    expect(out.published).toHaveLength(0);
  });

  it("re-publishes the event for a decided approval whose case never resumed (audit L3b)", async () => {
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const approvals = yield* ApprovalService;
          const row = yield* setupCase;
          const approval = yield* approvals.create({
            tenantId,
            caseId: row.id,
            agentId: AgentId("refund-review-agent"),
            tool: "conversation.reply",
            proposedInput: {},
            reasoning: "test",
            riskLevel: "medium",
            expiresAt: new Date(Date.now() + 60_000),
          });
          // Decided 10 minutes ago — but the case is still parked
          // (the publish was lost).
          yield* approvals.approve({
            id: approval.id,
            decidedBy: UserId("manager-1"),
          });
          const published: DomainEvent[] = [];
          const result = yield* runApprovalMaintenanceOnce({
            publish: (e) => {
              published.push(e);
              return Promise.resolve();
            },
            now: new Date(Date.now() + 10 * 60_000),
          });
          return { result, published, approvalId: approval.id, caseId: row.id };
        }),
        layer,
      ) as Effect.Effect<
        {
          result: { expired: number; republished: number };
          published: ReadonlyArray<DomainEvent>;
          approvalId: string;
          caseId: string;
        },
        never,
        never
      >,
    );

    expect(out.result.republished).toBe(1);
    expect(out.published).toHaveLength(1);
    const event = out.published[0]!;
    expect(event.type).toBe("approval.approved");
    if (event.type === "approval.approved") {
      expect(event.approvalId).toBe(out.approvalId);
      expect(event.caseId).toBe(out.caseId);
    }
  });

  it("does not republish when the case already moved on", async () => {
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* CaseRepository;
          const approvals = yield* ApprovalService;
          const row = yield* setupCase;
          const approval = yield* approvals.create({
            tenantId,
            caseId: row.id,
            agentId: AgentId("refund-review-agent"),
            tool: "conversation.reply",
            proposedInput: {},
            reasoning: "test",
            riskLevel: "medium",
            expiresAt: new Date(Date.now() + 60_000),
          });
          yield* approvals.approve({
            id: approval.id,
            decidedBy: UserId("manager-1"),
          });
          // The runtime already resumed and resolved the case.
          yield* repo.transitionStatus(row.id, "resolved", {
            reason: "resumed normally",
          });
          const published: DomainEvent[] = [];
          const result = yield* runApprovalMaintenanceOnce({
            publish: (e) => {
              published.push(e);
              return Promise.resolve();
            },
            now: new Date(Date.now() + 10 * 60_000),
          });
          return { result, published };
        }),
        layer,
      ) as Effect.Effect<
        {
          result: { expired: number; republished: number };
          published: ReadonlyArray<DomainEvent>;
        },
        never,
        never
      >,
    );

    expect(out.result.republished).toBe(0);
    expect(out.published).toHaveLength(0);
  });
});
