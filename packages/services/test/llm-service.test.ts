import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentId,
  TenantId,
  type LLMDecision,
} from "@support-agent/agent-core";
import {
  LLMService,
  LLMServiceFromFn,
  LLMServiceScripted,
} from "../src/llm-service.js";

const baseReq = {
  tenantId: TenantId("00000000-0000-0000-0000-000000000001"),
  model: "google/gemini-3.1-flash-lite",
  system: "test system",
  messages: [],
  tools: [],
};

const sampleDecision = (text: string): LLMDecision => ({
  type: "final_message",
  text,
});

describe("LLMServiceScripted", () => {
  it("pops one decision per call in order", async () => {
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const llm = yield* LLMService;
          const a = yield* llm.runToolCalling(baseReq);
          const b = yield* llm.runToolCalling(baseReq);
          const c = yield* llm.runToolCalling(baseReq);
          return [a, b, c];
        }),
        LLMServiceScripted([
          sampleDecision("first"),
          sampleDecision("second"),
          sampleDecision("third"),
        ]),
      ),
    );
    expect(result.map((d) => (d.type === "final_message" ? d.text : ""))).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("dies (test bug) when the script is exhausted", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.gen(function* () {
          const llm = yield* LLMService;
          yield* llm.runToolCalling(baseReq);
          return yield* llm.runToolCalling(baseReq);
        }),
        LLMServiceScripted([sampleDecision("only")]),
      ),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      // Effect.die yields a Die cause, not Fail
      expect(exit.cause._tag).toBe("Die");
    }
  });
});

describe("LLMServiceFromFn", () => {
  it("invokes the function with the request and a monotonically increasing callIndex", async () => {
    const decisions = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const llm = yield* LLMService;
          const a = yield* llm.runToolCalling(baseReq);
          const b = yield* llm.runToolCalling(baseReq);
          return [a, b];
        }),
        LLMServiceFromFn((_req, { callIndex }) =>
          Effect.succeed<LLMDecision>(
            callIndex === 0
              ? {
                  type: "tool_call",
                  callId: "c0",
                  tool: "ticket.update_context",
                  input: {},
                }
              : { type: "final_message", text: "done" },
          ),
        ),
      ),
    );
    expect(decisions[0]?.type).toBe("tool_call");
    expect(decisions[1]?.type).toBe("final_message");
  });

  it("can route on request shape (e.g. last user message)", async () => {
    const decisions = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const llm = yield* LLMService;
          return yield* llm.runToolCalling({
            ...baseReq,
            messages: [{ role: "user", content: "where is my order?" }],
          });
        }),
        LLMServiceFromFn((req) =>
          Effect.succeed<LLMDecision>(
            req.messages.some(
              (m) => m.role === "user" && m.content.includes("order"),
            )
              ? {
                  type: "handoff",
                  targetAgent: AgentId("order-status-agent"),
                  reason: "matches order pattern",
                }
              : { type: "final_message", text: "fallback" },
          ),
        ),
      ),
    );
    expect(decisions.type).toBe("handoff");
    if (decisions.type === "handoff") {
      expect(decisions.targetAgent).toBe("order-status-agent");
    }
  });
});
