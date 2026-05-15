import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentRegistryWith,
  CaseId,
  PermissionServiceDefault,
  TenantId,
  ToolRegistryWith,
  type DomainEvent,
  type LLMDecision,
} from "@support-agent/agent-core";
import { supportTriage } from "@support-agent/agents";
import {
  caseUpdateContext,
  caseUpdateStatus,
} from "@support-agent/tools";
import {
  AgentRuntime,
  AgentRuntimeDefault,
  ApprovalServiceTest,
  AuditLogService,
  AuditLogServiceTest,
  CaseRepository,
  CaseRepositoryTest,
  LLMServiceScripted,
  TransactionRunnerPassthrough,
} from "@support-agent/services";

// ------------------------------------------------------------
// The scripted LLM run for support-triage:
//   turn 0: write classification into context
//   turn 1: transition the case to resolved
//   turn 2: final_message → runtime returns Completed
// ------------------------------------------------------------
const triageScript: ReadonlyArray<LLMDecision> = [
  {
    type: "tool_call",
    callId: "c0",
    tool: "case.update_context",
    input: {
      classification: "where_is_order",
      identifiedOrderId: "ord_42",
      notes: "customer wants tracking",
    },
  },
  {
    type: "tool_call",
    callId: "c1",
    tool: "case.update_status",
    input: { status: "resolved", reason: "triage complete" },
  },
  {
    type: "final_message",
    text: "Classified as where_is_order; case resolved.",
  },
];

const tickEnv = Layer.mergeAll(
  CaseRepositoryTest,
  AuditLogServiceTest,
  ApprovalServiceTest,
  AgentRegistryWith([supportTriage]),
  ToolRegistryWith([caseUpdateStatus as never, caseUpdateContext as never]),
  PermissionServiceDefault,
  LLMServiceScripted(triageScript),
  TransactionRunnerPassthrough,
);

const runtimeLayer = AgentRuntimeDefault.pipe(Layer.provide(tickEnv));
// Provide the inspection services on top of the runtime so the test can also
// poke at the case + audit log after the tick.
const fullLayer = Layer.merge(runtimeLayer, tickEnv);

const ticketCreated = (
  body: string,
  tenantId = "tenant-acme",
): DomainEvent => ({
  type: "ticket.created",
  tenantId: TenantId(tenantId),
  source: "api",
  payload: {
    subject: "Where is my order?",
    body,
    customerEmail: "cust@example.com",
    metadata: {},
  },
});

describe("AgentRuntime — e2e ticket.created → resolved", () => {
  it("triages a ticket end-to-end via support-triage", async () => {
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* CaseRepository;
          const audit = yield* AuditLogService;

          const workflow = yield* runtime.handleEvent(
            ticketCreated("My order is late."),
          );

          // Pull state back out for assertions.
          const cases = yield* repo
            .findByThreadId(TenantId("tenant-acme"), "never" as never)
            .pipe(Effect.map(() => null)); // unused, but exercises Tag

          // We don't know the generated caseId from the outside, so we list
          // pending approvals (none expected) and re-derive by querying audit
          // entries. Simpler: walk the audit log for any case in this tenant.
          // The Test layer doesn't expose a "all cases" listing — but the
          // workflow result + audit entries are enough for the assertions.

          // Fetch all audit entries by re-using the in-memory caseId from the
          // event.received entry. We need a caseId; the test layer stores it.
          // We can find it via the only created case: list approvals (none),
          // and check audit by scanning a known caseId. Since we can't, we
          // resort to inspecting the workflow result + that *something*
          // happened.

          // Pragmatic approach: pull the audit log by enumerating a few caseIds
          // is not possible; instead expose via repo.findByThreadId(null) (we
          // didn't set a threadId). For Phase 1 minimum we assert via
          // workflow + repo.getById with a known id — see test below.

          return { workflow, cases };
        }),
        fullLayer,
      ),
    );

    expect(result.workflow.type).toBe("Completed");
  });

  it("produces the expected audit trail (event.received + 3 llm.decision + 2 tool.invoked)", async () => {
    // To assert on the audit trail we need the caseId. Take a different path:
    // create the case explicitly via the repo first (status=new), then dispatch
    // a customer.replied event to drive the runtime — same tick logic, but the
    // caseId is known to the test.
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* CaseRepository;
          const audit = yield* AuditLogService;

          // Bootstrap a fresh case in "new" state.
          const created = yield* repo.create({
            tenantId: TenantId("tenant-acme"),
            channel: "email",
            currentAgentId: supportTriage.id,
            subject: "Where is my order?",
          });

          const result = yield* runtime.handleEvent({
            type: "customer.replied",
            caseId: created.id,
            payload: {
              threadId: "thread-x" as never,
              messageId: "msg-1",
              from: { name: null, email: "cust@example.com" },
              to: [],
              subject: "Re: Where is my order?",
              bodyText: "Tracking? Order ord_42.",
              bodyHtml: null,
              receivedAt: new Date(),
              attachments: [],
            },
          });

          const fetched = yield* repo.getById(created.id);
          const entries = yield* audit.forCase(created.id);
          return { result, fetched, entries };
        }),
        fullLayer,
      ),
    );

    expect(out.result.type).toBe("Completed");
    expect(out.fetched.status).toBe("resolved");
    expect(out.fetched.context["classification"]).toBe("where_is_order");
    expect(out.fetched.context["identifiedOrderId"]).toBe("ord_42");

    // Audit trail shape: event.received + 3 llm.decision + 2 tool.invoked.
    // No trailing `case.resolved` here because the case was already
    // resolved by the second tool call before the final_message turn — the
    // runtime's transition-on-final-message branch is a no-op when status
    // is already "resolved".
    const actions = out.entries.map((e) => e.action);
    expect(actions).toEqual([
      "event.received",
      "llm.decision",
      "tool.invoked",
      "llm.decision",
      "tool.invoked",
      "llm.decision",
    ]);
    // Actor types: system for event.received, agent for the rest.
    expect(out.entries[0]?.actor.type).toBe("system");
    for (const e of out.entries.slice(1)) {
      expect(e.actor.type).toBe("agent");
      expect(e.actor.id).toBe(supportTriage.id);
    }
  });

  it("returns HumanTakeoverRequired when the script exhausts maxTurnsPerTick", async () => {
    // Use a script that never returns final_message: just keeps emitting
    // tool calls. maxTurnsPerTick is 4 for support-triage, so after 4 turns
    // the runtime must give up.
    const loopScript: ReadonlyArray<LLMDecision> = Array.from(
      { length: 10 },
      (_, i) => ({
        type: "tool_call",
        callId: `c${i}`,
        tool: "case.update_context",
        input: { notes: `loop ${i}` },
      }),
    );

    const layer = Layer.merge(
      AgentRuntimeDefault.pipe(
        Layer.provide(
          Layer.mergeAll(
            CaseRepositoryTest,
            AuditLogServiceTest,
            ApprovalServiceTest,
            AgentRegistryWith([supportTriage]),
            ToolRegistryWith([
              caseUpdateStatus as never,
              caseUpdateContext as never,
            ]),
            PermissionServiceDefault,
            LLMServiceScripted(loopScript),
            TransactionRunnerPassthrough,
          ),
        ),
      ),
      CaseRepositoryTest,
    );

    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          return yield* runtime.handleEvent(ticketCreated("loop"));
        }),
        layer,
      ),
    );
    expect(result.type).toBe("HumanTakeoverRequired");
    if (result.type === "HumanTakeoverRequired") {
      expect(result.reason).toBe("max_turns_exceeded");
    }
  });
});
