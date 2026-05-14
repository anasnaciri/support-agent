import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentId,
  CaseRepositoryTest,
  CaseRepository,
  ToolOutputInvalid,
  TenantId,
  ToolRegistryWith,
  ToolRegistry,
  type ToolContext,
} from "@support-agent/agent-core";
// Note: CaseRepositoryTest / CaseRepository are imported from agent-core via
// the services re-export chain; this matches the runtime DI shape.
// vitest-friendly re-imports below are direct from services to be explicit.

import {
  CaseRepository as RepoTag,
  CaseRepositoryTest as RepoTestLayer,
} from "@support-agent/services";

import { caseUpdateStatus, caseUpdateContext } from "../src/index.js";

const baseCtx = (caseId: string): ToolContext => ({
  tenantId: TenantId("t1"),
  caseId: caseId as never,
  agentId: AgentId("support-triage"),
  callId: "call_1",
  attemptNumber: 1,
});

// Layer for running tool executions: provides both the Test CaseRepository
// and a ToolRegistry pre-loaded with both case tools (so consumers can also
// resolve them by name through the registry if they want).
const toolEnv = Layer.merge(
  RepoTestLayer,
  ToolRegistryWith([caseUpdateStatus as never, caseUpdateContext as never]),
);

describe("case.update_status tool", () => {
  it("transitions the case status and returns the new status", async () => {
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* RepoTag;
          const created = yield* repo.create({
            tenantId: TenantId("t1"),
            channel: "email",
            currentAgentId: AgentId("support-triage"),
          });
          const out = yield* caseUpdateStatus.execute(
            { status: "resolved", reason: "test" },
            baseCtx(created.id),
          );
          return out;
        }),
        toolEnv,
      ),
    );
    expect(result.status).toBe("resolved");
  });

  it("returns ToolOutputInvalid when the optimistic expectedFromStatus mismatches", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* RepoTag;
          const created = yield* repo.create({
            tenantId: TenantId("t1"),
            channel: "email",
            currentAgentId: AgentId("support-triage"),
            status: "in_progress",
          });
          return yield* caseUpdateStatus.execute(
            { status: "resolved", expectedFromStatus: "new" },
            baseCtx(created.id),
          );
        }),
        toolEnv,
      ),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(ToolOutputInvalid);
      expect((exit.cause.error as ToolOutputInvalid).issues).toContain(
        "CaseStateConflict",
      );
    }
  });

  it("ships with a JSON-Schema-able input definition", () => {
    // sanity that we can decode a payload the LLM might send
    const decoded = Schema.decodeUnknownSync(caseUpdateStatus.inputSchema)({
      status: "triaging",
    });
    expect(decoded.status).toBe("triaging");
  });
});

describe("case.update_context tool", () => {
  it("shallow-merges named hint fields into context", async () => {
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* RepoTag;
          const created = yield* repo.create({
            tenantId: TenantId("t1"),
            channel: "email",
            currentAgentId: AgentId("support-triage"),
            context: { initial: "value" },
          });
          yield* caseUpdateContext.execute(
            {
              classification: "where_is_order",
              identifiedOrderId: "ord_123",
              notes: "asked twice",
            },
            baseCtx(created.id),
          );
          return yield* repo.getById(created.id);
        }),
        toolEnv,
      ),
    );
    expect(result.context["initial"]).toBe("value"); // pre-existing keys preserved
    expect(result.context["classification"]).toBe("where_is_order");
    expect(result.context["identifiedOrderId"]).toBe("ord_123");
    expect(result.context["notes"]).toBe("asked twice");
  });

  it("accepts arbitrary extra keys via `extra` and merges them in", async () => {
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* RepoTag;
          const created = yield* repo.create({
            tenantId: TenantId("t1"),
            channel: "email",
            currentAgentId: AgentId("support-triage"),
          });
          yield* caseUpdateContext.execute(
            { extra: { carrier: "USPS", priorityHint: "p2" } },
            baseCtx(created.id),
          );
          return yield* repo.getById(created.id);
        }),
        toolEnv,
      ),
    );
    expect(result.context["carrier"]).toBe("USPS");
    expect(result.context["priorityHint"]).toBe("p2");
  });

  it("returns ToolOutputInvalid when the case does not exist", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        caseUpdateContext.execute(
          { classification: "general_inquiry" },
          baseCtx("missing"),
        ),
        toolEnv,
      ),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(ToolOutputInvalid);
    }
  });
});

describe("ToolRegistry integration with the case tools", () => {
  it("schemasFor returns LLM-shaped schemas for both case tools", async () => {
    const schemas = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const reg = yield* ToolRegistry;
          return yield* reg.schemasFor([
            "case.update_status",
            "case.update_context",
          ]);
        }),
        toolEnv,
      ),
    );
    expect(schemas.map((s) => s.name).sort()).toEqual([
      "case.update_context",
      "case.update_status",
    ]);
    for (const s of schemas) {
      expect(s.inputSchema["type"]).toBe("object");
    }
  });
});
