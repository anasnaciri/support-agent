import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";
import type { DomainEvent, WorkflowResult } from "@support-agent/agent-core";
import { AgentRuntime } from "@support-agent/services";
import {
  DEFAULT_WORKFLOW_CONSUMER_CONCURRENCY,
  DEFAULT_WORKFLOW_TICK_TIMEOUT_MS,
  processWorkflowEvent,
  registerWorkflowConsumer,
  workflowConsumerConfig,
} from "../src/workflow-consumer.js";

// The event body is irrelevant here — the test AgentRuntime ignores it — but
// approval.approved is the event that stranded tickets in the prod incident this
// module fixes (a serial consumer starved these behind slow message.received
// runs), so it is the fitting sample.
const approvalEvent: DomainEvent = {
  type: "approval.approved",
  approvalId: "appr-1" as never,
  ticketId: "ticket-1" as never,
  managerId: "mgr-1" as never,
};

const makeRuntime = (
  handleEvent: (event: DomainEvent) => Effect.Effect<WorkflowResult, never>,
) => ManagedRuntime.make(Layer.succeed(AgentRuntime, AgentRuntime.of({ handleEvent })));

describe("workflowConsumerConfig", () => {
  it("defaults to concurrent processing + a bounded tick", () => {
    expect(workflowConsumerConfig({})).toEqual({
      concurrency: DEFAULT_WORKFLOW_CONSUMER_CONCURRENCY,
      tickTimeoutMs: DEFAULT_WORKFLOW_TICK_TIMEOUT_MS,
    });
    // The whole point of the fix: never ship a serial (1) consumer again.
    expect(DEFAULT_WORKFLOW_CONSUMER_CONCURRENCY).toBeGreaterThan(1);
  });

  it("reads env overrides", () => {
    expect(
      workflowConsumerConfig({
        WORKFLOW_CONSUMER_CONCURRENCY: "8",
        WORKFLOW_TICK_TIMEOUT_MS: "60000",
      }),
    ).toEqual({ concurrency: 8, tickTimeoutMs: 60000 });
  });

  it("clamps out-of-range and rejects garbage", () => {
    expect(
      workflowConsumerConfig({ WORKFLOW_CONSUMER_CONCURRENCY: "0" }).concurrency,
    ).toBe(1);
    expect(
      workflowConsumerConfig({ WORKFLOW_CONSUMER_CONCURRENCY: "999" })
        .concurrency,
    ).toBe(32);
    expect(
      workflowConsumerConfig({ WORKFLOW_CONSUMER_CONCURRENCY: "abc" })
        .concurrency,
    ).toBe(DEFAULT_WORKFLOW_CONSUMER_CONCURRENCY);
  });
});

describe("processWorkflowEvent", () => {
  it("completes on a terminal result", async () => {
    const rt = makeRuntime(() => Effect.succeed({ type: "Completed" }));
    const settlement = await processWorkflowEvent({
      runtime: rt,
      event: approvalEvent,
      tickTimeoutMs: 1000,
    });
    expect(settlement).toEqual({ kind: "complete", result: { type: "Completed" } });
    await rt.dispose();
  });

  it("retries a retryable Failed", async () => {
    const rt = makeRuntime(() =>
      Effect.succeed({ type: "Failed", reason: "llm 503", retryable: true }),
    );
    const settlement = await processWorkflowEvent({
      runtime: rt,
      event: approvalEvent,
      tickTimeoutMs: 1000,
    });
    expect(settlement).toEqual({ kind: "retry", reason: "llm 503" });
    await rt.dispose();
  });

  it("times out a hung tick into a retry instead of holding the work slot", async () => {
    const rt = makeRuntime(() =>
      Effect.as(Effect.sleep("500 millis"), { type: "Completed" } as WorkflowResult),
    );
    const settlement = await processWorkflowEvent({
      runtime: rt,
      event: approvalEvent,
      tickTimeoutMs: 20,
    });
    expect(settlement.kind).toBe("retry");
    if (settlement.kind === "retry") {
      expect(settlement.reason).toMatch(/exceeded/i);
    }
    await rt.dispose();
  });

  it("surfaces a defect so pg-boss retries (not a silent complete)", async () => {
    const rt = makeRuntime(() => Effect.die(new Error("kaboom")));
    const settlement = await processWorkflowEvent({
      runtime: rt,
      event: approvalEvent,
      tickTimeoutMs: 1000,
    });
    expect(settlement.kind).toBe("defect");
    if (settlement.kind === "defect") {
      expect(settlement.detail).toMatch(/kaboom/);
    }
    await rt.dispose();
  });
});

describe("registerWorkflowConsumer", () => {
  it("registers ONE work() with localConcurrency so distinct tickets run in parallel", async () => {
    const calls: Array<{ name: string; options: unknown }> = [];
    const fakeBoss = {
      work: async (name: string, options: unknown) => {
        calls.push({ name, options });
        return "worker-1";
      },
    };
    const id = await registerWorkflowConsumer({
      boss: fakeBoss as never,
      concurrency: 6,
      onJob: async () => {},
    });
    expect(id).toBe("worker-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("workflow.events");
    expect(calls[0]!.options).toEqual({ localConcurrency: 6 });
  });

  it("runs onJob for every job in a delivered batch", async () => {
    let handler:
      | ((jobs: ReadonlyArray<{ data: { eventId: string } }>) => Promise<void>)
      | undefined;
    const fakeBoss = {
      work: async (
        _name: string,
        _options: unknown,
        h: (jobs: ReadonlyArray<{ data: { eventId: string } }>) => Promise<void>,
      ) => {
        handler = h;
        return "w";
      },
    };
    const seen: string[] = [];
    await registerWorkflowConsumer({
      boss: fakeBoss as never,
      concurrency: 2,
      onJob: async (job) => {
        seen.push((job.data as { eventId: string }).eventId);
      },
    });
    await handler!([{ data: { eventId: "e1" } }, { data: { eventId: "e2" } }]);
    expect(seen).toEqual(["e1", "e2"]);
  });
});
