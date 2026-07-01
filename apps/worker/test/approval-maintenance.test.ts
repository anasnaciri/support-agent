import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentId,
  TenantId,
  UserId,
  type Approval,
  type DomainEvent,
} from "@support-agent/agent-core";
import {
  ApprovalService,
  ApprovalServiceTest,
  AuditLogServiceTest,
  CaseLifecycleWriterLive,
  CaseRepository,
  CaseRepositoryTest,
  TransactionRunnerPassthrough,
} from "@support-agent/services";
import { runApprovalMaintenanceOnce } from "../src/approval-maintenance-schedule.js";

// Audit L3b — approvals maintenance: decided approvals whose case never
// resumed (the workflow event was lost between decision-commit and
// publish) are re-published. (Time-based expiry of overdue pendings was
// removed — approval drafts no longer expire by age for any tool.)

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
          result: { republished: number };
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
          result: { republished: number };
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

// Reminder pass: a pending approval's FIRST notification is best-effort, so a
// dropped email/ping can silently strand a draft. The cron re-sends the same
// notification on a spaced cadence.
describe("runApprovalMaintenanceOnce — pending reminders", () => {
  const HOUR = 60 * 60_000;

  const seedPending = Effect.gen(function* () {
    const approvals = yield* ApprovalService;
    const row = yield* setupCase;
    const approval = yield* approvals.create({
      tenantId,
      caseId: row.id,
      agentId: AgentId("refund-review-agent"),
      tool: "conversation.reply",
      proposedInput: { subject: "Re: order", bodyText: "Draft reply" },
      reasoning: "test",
      riskLevel: "medium",
      expiresAt: new Date(Date.now() + 30 * 24 * HOUR),
    });
    return { row, approval };
  });

  const runAt = (nowOffsetMs: number, reminded: Approval[]) =>
    runApprovalMaintenanceOnce({
      publish: () => Promise.resolve(),
      notify: (a) => {
        reminded.push(a);
        return Promise.resolve();
      },
      now: new Date(Date.now() + nowOffsetMs),
    });

  it("re-notifies a pending approval once its grace has elapsed", async () => {
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const { approval } = yield* seedPending;
          const reminded: Approval[] = [];
          // 1h after creation: past the 30-min grace, never reminded.
          const result = yield* runAt(1 * HOUR, reminded);
          return { result, reminded, approvalId: approval.id };
        }),
        layer,
      ) as Effect.Effect<
        {
          result: { reminded: number };
          reminded: ReadonlyArray<Approval>;
          approvalId: string;
        },
        never,
        never
      >,
    );

    expect(out.result.reminded).toBe(1);
    expect(out.reminded).toHaveLength(1);
    expect(out.reminded[0]!.id).toBe(out.approvalId);
  });

  it("does not re-notify twice inside the reminder interval", async () => {
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* seedPending;
          const reminded: Approval[] = [];
          yield* runAt(1 * HOUR, reminded); // first reminder
          const second = yield* runAt(2 * HOUR, reminded); // 1h later — still inside 24h
          return { second, reminded };
        }),
        layer,
      ) as Effect.Effect<
        { second: { reminded: number }; reminded: ReadonlyArray<Approval> },
        never,
        never
      >,
    );

    expect(out.second.reminded).toBe(0);
    expect(out.reminded).toHaveLength(1);
  });

  it("re-notifies again after the interval elapses", async () => {
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* seedPending;
          const reminded: Approval[] = [];
          yield* runAt(1 * HOUR, reminded); // first
          const later = yield* runAt(1 * HOUR + 25 * HOUR, reminded); // >24h later
          return { later, reminded };
        }),
        layer,
      ) as Effect.Effect<
        { later: { reminded: number }; reminded: ReadonlyArray<Approval> },
        never,
        never
      >,
    );

    expect(out.later.reminded).toBe(1);
    expect(out.reminded).toHaveLength(2);
  });

  it("stops nagging once the approval is older than the reminder window", async () => {
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* seedPending;
          const reminded: Approval[] = [];
          // 8 days after creation — past the 7-day window.
          const result = yield* runAt(8 * 24 * HOUR, reminded);
          return { result, reminded };
        }),
        layer,
      ) as Effect.Effect<
        { result: { reminded: number }; reminded: ReadonlyArray<Approval> },
        never,
        never
      >,
    );

    expect(out.result.reminded).toBe(0);
    expect(out.reminded).toHaveLength(0);
  });

  it("skips a reminder when the case is no longer parked for approval", async () => {
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* CaseRepository;
          const { row } = yield* seedPending;
          // The case was taken over by a human, but the approval row lingers.
          yield* repo.transitionStatus(row.id, "human_takeover", {
            reason: "manual takeover",
          });
          const reminded: Approval[] = [];
          const result = yield* runAt(1 * HOUR, reminded);
          return { result, reminded };
        }),
        layer,
      ) as Effect.Effect<
        { result: { reminded: number }; reminded: ReadonlyArray<Approval> },
        never,
        never
      >,
    );

    expect(out.result.reminded).toBe(0);
    expect(out.reminded).toHaveLength(0);
  });
});
