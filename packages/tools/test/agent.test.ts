import { Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentId,
  CaseId,
  TenantId,
  type ToolContext,
} from "@support-agent/agent-core";
import { agentHandoff } from "../src/index.js";

const baseCtx: ToolContext = {
  tenantId: TenantId("t1"),
  caseId: CaseId("c1"),
  agentId: AgentId("support-triage"),
  callId: "call_1",
  attemptNumber: 1,
};

describe("agent.handoff tool", () => {
  it("declares the runtime-control shape (read / allow / none)", () => {
    expect(agentHandoff.name).toBe("agent.handoff");
    expect(agentHandoff.risk).toBe("read");
    expect(agentHandoff.defaultPermission).toBe("allow");
    expect(agentHandoff.sideEffectClass).toBe("none");
  });

  it("decodes a valid input through its inputSchema", async () => {
    const decoded = await Effect.runPromise(
      Schema.decodeUnknown(agentHandoff.inputSchema)({
        targetAgent: "order-status-agent",
        reason: "hand off",
      }),
    );
    expect(decoded).toEqual({
      targetAgent: "order-status-agent",
      reason: "hand off",
    });
  });

  it("rejects input missing targetAgent", async () => {
    const exit = await Effect.runPromiseExit(
      Schema.decodeUnknown(agentHandoff.inputSchema)({ reason: "x" }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("body is a safe no-op that echoes the targetAgent (runtime normally intercepts)", async () => {
    const exit = await Effect.runPromiseExit(
      agentHandoff.execute(
        { targetAgent: "order-status-agent" } as never,
        baseCtx,
      ) as Effect.Effect<unknown, unknown, never>,
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toEqual({
        ok: true,
        targetAgent: "order-status-agent",
      });
    }
  });
});
