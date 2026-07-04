import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentId,
  TenantId,
  type DomainEvent,
  type WorkflowResult,
} from "@support-agent/agent-core";
import {
  ApprovalServiceTest,
  AuditLogService,
  AuditLogServiceTest,
  CaseLifecycleWriterLive,
  CaseRepository,
  CaseRepositoryTest,
  TransactionRunnerPassthrough,
  makeMerchantNotificationServiceTest,
} from "@support-agent/services";
import { settleWorkflowResult } from "../src/workflow-job.js";
import { escalateDeadLetteredEvent } from "../src/workflow-dead-letter.js";

// ------------------------------------------------------------
// Audit C1/L11 — worker-side settlement of a tick's WorkflowResult.
// `Failed retryable:true` must surface as a retry (throw → pg-boss
// backoff); everything else completes the job. Dead-lettered events
// must park their case in human_takeover so retry exhaustion is
// visible instead of silently dropping the event.
// ------------------------------------------------------------

describe("settleWorkflowResult", () => {
  it("retries a retryable Failed", () => {
    const result: WorkflowResult = {
      type: "Failed",
      reason: "llm transient error: ProviderUnavailable",
      retryable: true,
    };
    expect(settleWorkflowResult(result)).toEqual({
      kind: "retry",
      reason: "llm transient error: ProviderUnavailable",
    });
  });

  it("completes a non-retryable Failed", () => {
    const result: WorkflowResult = {
      type: "Failed",
      reason: "approval x not found",
      retryable: false,
    };
    expect(settleWorkflowResult(result)).toEqual({ kind: "complete" });
  });

  it("completes terminal and paused results", () => {
    const results: ReadonlyArray<WorkflowResult> = [
      { type: "Completed" },
      { type: "PausedWaitingForCustomer" },
      { type: "PausedForHumanTakeover" },
      { type: "PausedArchived" },
      { type: "HumanTakeoverRequired", reason: "max_turns_exceeded" },
    ];
    for (const r of results) {
      expect(settleWorkflowResult(r)).toEqual({ kind: "complete" });
    }
  });
});

describe("escalateDeadLetteredEvent", () => {
  const deps = Layer.mergeAll(
    ApprovalServiceTest,
    CaseRepositoryTest,
    AuditLogServiceTest,
    TransactionRunnerPassthrough,
  );
  const layer = Layer.provideMerge(CaseLifecycleWriterLive, deps);

  it("parks the dead-lettered event's case in human_takeover with an audit row", async () => {
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* CaseRepository;
          const audit = yield* AuditLogService;
          const created = yield* repo.create({
            tenantId: TenantId("tenant-acme"),
            channel: "email",
            currentAgentId: AgentId("support-triage"),
            subject: "Dead letter test",
          });
          const event: DomainEvent = {
            type: "customer.replied",
            caseId: created.id,
            payload: {
              threadId: "thread-dl" as never,
              messageId: "msg-dl",
              from: { name: null, email: "cust@example.com" },
              to: [],
              subject: "Help",
              bodyText: "Hello",
              bodyHtml: null,
              receivedAt: new Date(),
              attachments: [],
            },
          };
          yield* escalateDeadLetteredEvent(event);
          const fetched = yield* repo.getById(created.id);
          const entries = yield* audit.forCase(created.id);
          return { fetched, entries };
        }),
        layer,
      ),
    );

    expect(out.fetched.status).toBe("human_takeover");
    expect(out.entries.map((e) => e.action)).toContain(
      "case.escalated_to_human",
    );
  });

  it("resolves the case for a dead-lettered message.received via the thread id", async () => {
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* CaseRepository;
          const created = yield* repo.create({
            tenantId: TenantId("tenant-acme"),
            channel: "email",
            currentAgentId: AgentId("support-triage"),
            subject: "Dead letter thread test",
            threadId: "thread-dl-2" as never,
          });
          const event: DomainEvent = {
            type: "message.received",
            tenantId: TenantId("tenant-acme"),
            threadId: "thread-dl-2" as never,
            payload: {
              threadId: "thread-dl-2" as never,
              messageId: "msg-dl-2",
              from: { name: null, email: "cust@example.com" },
              to: [],
              subject: "Help",
              bodyText: "Hello",
              bodyHtml: null,
              receivedAt: new Date(),
              attachments: [],
            },
          };
          yield* escalateDeadLetteredEvent(event);
          const fetched = yield* repo.getById(created.id);
          return { fetched };
        }),
        layer,
      ),
    );

    expect(out.fetched.status).toBe("human_takeover");
  });

  it("leaves an already human_takeover case untouched (idempotent)", async () => {
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* CaseRepository;
          const audit = yield* AuditLogService;
          const created = yield* repo.create({
            tenantId: TenantId("tenant-acme"),
            channel: "email",
            currentAgentId: AgentId("support-triage"),
            subject: "Already parked",
          });
          yield* repo.transitionStatus(created.id, "human_takeover", {
            reason: "test setup",
          });
          const event: DomainEvent = {
            type: "customer.replied",
            caseId: created.id,
            payload: {
              threadId: "thread-dl-3" as never,
              messageId: "msg-dl-3",
              from: { name: null, email: "cust@example.com" },
              to: [],
              subject: "Help",
              bodyText: "Hello",
              bodyHtml: null,
              receivedAt: new Date(),
              attachments: [],
            },
          };
          yield* escalateDeadLetteredEvent(event);
          const fetched = yield* repo.getById(created.id);
          const entries = yield* audit.forCase(created.id);
          return { fetched, entries };
        }),
        layer,
      ),
    );

    expect(out.fetched.status).toBe("human_takeover");
    // No second escalation audit row.
    expect(
      out.entries.filter((e) => e.action === "case.escalated_to_human"),
    ).toHaveLength(0);
  });

  it("never fails on an unknown case (logs and moves on)", async () => {
    await Effect.runPromise(
      Effect.provide(
        escalateDeadLetteredEvent({
          type: "customer.replied",
          caseId: "case-does-not-exist" as never,
          payload: {
            threadId: "thread-x" as never,
            messageId: "msg-x",
            from: { name: null, email: "x@example.com" },
            to: [],
            subject: "x",
            bodyText: "x",
            bodyHtml: null,
            receivedAt: new Date(),
            attachments: [],
          },
        }),
        layer,
      ),
    );
  });
});

describe("escalateDeadLetteredEvent — merchant notification", () => {
  it("pings the merchant after parking the case (best-effort)", async () => {
    const { layer: notifLayer, handle } = makeMerchantNotificationServiceTest();
    const deps = Layer.mergeAll(
      ApprovalServiceTest,
      CaseRepositoryTest,
      AuditLogServiceTest,
      TransactionRunnerPassthrough,
      notifLayer,
    );
    const layer = Layer.provideMerge(CaseLifecycleWriterLive, deps);
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* CaseRepository;
          const created = yield* repo.create({
            tenantId: "t1" as never,
            channel: "email",
            currentAgentId: "support-triage" as never,
            subject: "Where is my order?",
          });
          yield* escalateDeadLetteredEvent({
            type: "customer.replied",
            caseId: created.id,
            payload: {
              threadId: "th-1" as never,
              messageId: "m1",
              from: { name: null, email: "c@example.com" },
              to: [],
              subject: "Re: Where is my order?",
              bodyText: "hello?",
              bodyHtml: null,
              receivedAt: new Date(),
              attachments: [],
            },
          });
          return { caseId: created.id, row: yield* repo.getById(created.id) };
        }),
        layer,
      ),
    );
    expect(out.row.status).toBe("human_takeover");
    expect(handle.sent).toHaveLength(1);
    const sent = handle.sent[0]!;
    expect(sent.notification.kind).toBe("human_takeover");
    expect(sent.notification.caseId).toBe(out.caseId);
    expect(sent.notification.body).not.toContain("workflow_retries_exhausted");
  });

  it("does not ping when the case is already parked or resolved", async () => {
    const { layer: notifLayer, handle } = makeMerchantNotificationServiceTest();
    const deps = Layer.mergeAll(
      ApprovalServiceTest,
      CaseRepositoryTest,
      AuditLogServiceTest,
      TransactionRunnerPassthrough,
      notifLayer,
    );
    const layer = Layer.provideMerge(CaseLifecycleWriterLive, deps);
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* CaseRepository;
          const created = yield* repo.create({
            tenantId: "t1" as never,
            channel: "email",
            currentAgentId: "support-triage" as never,
          });
          yield* repo.transitionStatus(created.id, "human_takeover", {
            reason: "manual",
          });
          yield* escalateDeadLetteredEvent({
            type: "case.resumed",
            caseId: created.id,
            payload: { trigger: "dashboard_retry" },
          } as never);
        }),
        layer,
      ),
    );
    expect(handle.sent).toHaveLength(0);
  });
});
