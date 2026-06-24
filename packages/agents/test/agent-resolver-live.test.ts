import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import {
  AgentId,
  AgentRegistryWith,
  ConnectorStoreDbError,
  TenantId,
  type AgentConfig,
} from "@support-agent/agent-core";
import {
  AgentResolver,
  CustomAgentService,
  CustomAgentServiceTest,
  type CustomAgentRecord,
} from "@support-agent/services";
import {
  AgentResolverLive,
  customRecordToAgentConfig,
} from "../src/index.js";
import { CUSTOM_AGENT_INSTRUCTIONS_OPEN } from "../src/custom-agent-scaffold.js";

const tenantA = TenantId("tenant-a");

const builtin: AgentConfig = {
  id: AgentId("order-status-agent"),
  name: "Order Status",
  description: "Built-in.",
  mode: "subagent",
  provider: "openrouter",
  model: "google/gemini-3.5-flash",
  promptTemplate: "builtin prompt",
  tools: ["shopify.get_order"],
  permissionOverrides: {},
  handoffs: [],
  maxTurnsPerTick: 6,
};

const record = (over: Partial<CustomAgentRecord> = {}): CustomAgentRecord => ({
  agentId: AgentId("custom:x"),
  name: "Returns Concierge",
  description: "Handles returns.",
  instructions: "Be warm.",
  model: "anthropic/claude-haiku-4-5",
  tools: ["shopify.get_order", "conversation.reply"],
  handoffs: [],
  callableFrom: [],
  permissionOverrides: { "conversation.reply": "ask" },
  whenToUse: null,
  maxTurnsPerTick: 9,
  status: "active",
  createdAt: new Date("2026-06-01"),
  updatedAt: new Date("2026-06-01"),
  ...over,
});

describe("customRecordToAgentConfig", () => {
  it("pins mode/provider, maps fields, and wraps the prompt in the scaffold", () => {
    const cfg = customRecordToAgentConfig(record());
    expect(cfg.id).toBe(AgentId("custom:x"));
    expect(cfg.mode).toBe("subagent");
    expect(cfg.provider).toBe("openrouter");
    expect(cfg.model).toBe("anthropic/claude-haiku-4-5");
    expect(cfg.maxTurnsPerTick).toBe(9);
    expect(cfg.permissionOverrides).toEqual({ "conversation.reply": "ask" });
    expect(cfg.promptTemplate).toContain('You are "Returns Concierge"');
    expect(cfg.promptTemplate).toContain(CUSTOM_AGENT_INSTRUCTIONS_OPEN);
    expect(cfg.promptTemplate).toContain("Be warm.");
  });

  it("omits agent.handoff when there are no handoff targets", () => {
    const cfg = customRecordToAgentConfig(record({ handoffs: [] }));
    expect(cfg.tools).toEqual(["shopify.get_order", "conversation.reply"]);
    expect(cfg.handoffs).toEqual([]);
  });

  it("adds agent.handoff exactly once when the agent can hand off", () => {
    const cfg = customRecordToAgentConfig(
      record({
        tools: ["shopify.get_order", "agent.handoff"],
        handoffs: [AgentId("refund-review-agent")],
      }),
    );
    expect(cfg.tools.filter((t) => t === "agent.handoff")).toHaveLength(1);
    expect(cfg.tools).toContain("agent.handoff");
    expect(cfg.handoffs).toEqual([AgentId("refund-review-agent")]);
  });
});

describe("AgentResolverLive", () => {
  const liveLayer = (
    customLayer = CustomAgentServiceTest([
      { tenantId: tenantA, record: record() },
    ]),
  ) =>
    AgentResolverLive.pipe(
      Layer.provide(Layer.merge(AgentRegistryWith([builtin]), customLayer)),
    );

  const resolve = (
    agentId: string,
    customLayer?: Layer.Layer<CustomAgentService>,
  ) =>
    Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const r = yield* AgentResolver;
          return yield* r.tryResolve(tenantA, AgentId(agentId));
        }),
        liveLayer(customLayer),
      ),
    );

  it("resolves a built-in agent (registry wins)", async () => {
    const cfg = await resolve("order-status-agent");
    expect(cfg?.promptTemplate).toBe("builtin prompt");
  });

  it("falls back to an active custom agent", async () => {
    const cfg = await resolve("custom:x");
    expect(cfg?.name).toBe("Returns Concierge");
    expect(cfg?.mode).toBe("subagent");
  });

  it("returns null for an unknown id", async () => {
    const cfg = await resolve("custom:nope");
    expect(cfg).toBeNull();
  });

  it("fail-safe: a custom-store DB error resolves to null, not a failure", async () => {
    const failing = Layer.succeed(
      CustomAgentService,
      CustomAgentService.of({
        tryResolve: () =>
          Effect.fail(new ConnectorStoreDbError({ cause: "boom" })),
        listForTenant: () => Effect.succeed([]),
        get: () => Effect.succeed(null),
        create: () => Effect.die("unused"),
        update: () => Effect.die("unused"),
        delete: () => Effect.void,
      }),
    );
    const cfg = await resolve("custom:x", failing);
    expect(cfg).toBeNull();
  });
});
