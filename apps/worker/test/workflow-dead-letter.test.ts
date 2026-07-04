import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { AgentId, TenantId, type DomainEvent } from "@support-agent/agent-core";
import {
  ApprovalServiceTest,
  AuditLogService,
  AuditLogServiceTest,
  TicketLifecycleWriterLive,
  TicketRepository,
  TicketRepositoryTest,
  TransactionRunnerPassthrough,
} from "@support-agent/services";
import { escalateDeadLetteredEvent } from "../src/workflow-dead-letter.js";

const deps = Layer.mergeAll(
  ApprovalServiceTest,
  TicketRepositoryTest,
  AuditLogServiceTest,
  TransactionRunnerPassthrough,
);
const layer = Layer.provideMerge(TicketLifecycleWriterLive, deps);

const timerExpired = (ticketId: string): DomainEvent => ({
  type: "timer.expired",
  ticketId: ticketId as never,
  timerId: "t1",
  reason: "follow_up",
});

describe("escalateDeadLetteredEvent — underlying failure reason", () => {
  it("records the underlying tick error in the escalation audit details", async () => {
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const tickets = yield* TicketRepository;
          const audit = yield* AuditLogService;
          const created = yield* tickets.create({
            tenantId: TenantId("tenant-dl"),
            channel: "email",
            currentAgentId: AgentId("scenario-resolution-agent"),
            subject: "Dead letter test",
          });
          yield* escalateDeadLetteredEvent(
            timerExpired(created.id),
            "retryable workflow failure: llm transient error: ProviderUnavailable",
          );
          const fetched = yield* tickets.getById(created.id);
          const entries = yield* audit.forTicket(created.id);
          return { fetched, entries };
        }),
        layer,
      ) as Effect.Effect<
        {
          readonly fetched: { readonly status: string };
          readonly entries: ReadonlyArray<{
            readonly action: string;
            readonly details: Readonly<Record<string, unknown>>;
          }>;
        },
        never,
        never
      >,
    );

    expect(out.fetched.status).toBe("human_takeover");
    const escalation = out.entries.find(
      (e) => e.action === "ticket.escalated_to_human",
    );
    expect(escalation?.details["reason"]).toBe("workflow_retries_exhausted");
    // The actual cause that exhausted the retries is preserved for diagnosis,
    // instead of being lost to the worker's (rotated) stdout.
    expect(String(escalation?.details["underlyingError"])).toContain(
      "ProviderUnavailable",
    );
  });

  it("omits underlyingError when no reason is available", async () => {
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const tickets = yield* TicketRepository;
          const audit = yield* AuditLogService;
          const created = yield* tickets.create({
            tenantId: TenantId("tenant-dl2"),
            channel: "email",
            currentAgentId: AgentId("scenario-resolution-agent"),
            subject: "Dead letter test 2",
          });
          yield* escalateDeadLetteredEvent(timerExpired(created.id));
          const entries = yield* audit.forTicket(created.id);
          return { entries };
        }),
        layer,
      ) as Effect.Effect<
        {
          readonly entries: ReadonlyArray<{
            readonly action: string;
            readonly details: Readonly<Record<string, unknown>>;
          }>;
        },
        never,
        never
      >,
    );
    const escalation = out.entries.find(
      (e) => e.action === "ticket.escalated_to_human",
    );
    expect(escalation).toBeDefined();
    expect("underlyingError" in (escalation?.details ?? {})).toBe(false);
  });
});
