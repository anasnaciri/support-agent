import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { defineTool } from "../src/define-tool.js";
import {
  PermissionService,
  PermissionServiceDefault,
} from "../src/permission-service.js";
import { AgentId, TenantId } from "../src/ids.js";
import type { AgentConfig } from "../src/agent.js";

const baseAgent = (
  overrides: Record<string, "allow" | "ask" | "deny"> = {},
): AgentConfig => ({
  id: AgentId("support-triage"),
  name: "Support Triage",
  description: "Classifies inbound support tickets.",
  mode: "primary",
  provider: "openrouter",
  model: "anthropic/claude-3.5-sonnet",
  promptTemplate: "...",
  tools: ["case.update_status"],
  permissionOverrides: overrides,
  handoffs: [],
  maxTurnsPerTick: 4,
});

const readTool = defineTool({
  name: "shopify.get_order",
  description: "Read order.",
  inputSchema: Schema.Struct({ id: Schema.String }),
  outputSchema: Schema.Unknown,
  risk: "read",
  defaultPermission: "allow",
  sideEffectClass: "none",
  execute: () => Effect.succeed(undefined),
});

const writeTool = defineTool({
  name: "refund.create",
  description: "Issue a refund.",
  inputSchema: Schema.Struct({ amountCents: Schema.Number }),
  outputSchema: Schema.Unknown,
  risk: "money",
  defaultPermission: "ask",
  sideEffectClass: "financial",
  execute: () => Effect.succeed(undefined),
});

const run = <A, E>(eff: Effect.Effect<A, E, PermissionService>) =>
  Effect.runPromise(Effect.provide(eff, PermissionServiceDefault));

describe("PermissionService (default layer)", () => {
  it("returns the tool's defaultPermission when no override is present", async () => {
    const r1 = await run(
      Effect.gen(function* () {
        const perms = yield* PermissionService;
        return yield* perms.check({
          tenantId: TenantId("t1"),
          agent: baseAgent(),
          tool: readTool as never,
          payload: { id: "ord_1" },
        });
      }),
    );
    expect(r1).toBe("allow");

    const r2 = await run(
      Effect.gen(function* () {
        const perms = yield* PermissionService;
        return yield* perms.check({
          tenantId: TenantId("t1"),
          agent: baseAgent(),
          tool: writeTool as never,
          payload: { amountCents: 100 },
        });
      }),
    );
    expect(r2).toBe("ask");
  });

  it("override beats the tool default", async () => {
    const result = await run(
      Effect.gen(function* () {
        const perms = yield* PermissionService;
        return yield* perms.check({
          tenantId: TenantId("t1"),
          agent: baseAgent({ "shopify.get_order": "deny" }),
          tool: readTool as never,
          payload: {},
        });
      }),
    );
    expect(result).toBe("deny");
  });

  it("override can promote (ask → allow) as well as restrict", async () => {
    const result = await run(
      Effect.gen(function* () {
        const perms = yield* PermissionService;
        return yield* perms.check({
          tenantId: TenantId("t1"),
          agent: baseAgent({ "refund.create": "allow" }),
          tool: writeTool as never,
          payload: { amountCents: 100 },
        });
      }),
    );
    expect(result).toBe("allow");
  });

  it("an override for a different tool does not bleed across", async () => {
    const result = await run(
      Effect.gen(function* () {
        const perms = yield* PermissionService;
        return yield* perms.check({
          tenantId: TenantId("t1"),
          agent: baseAgent({ "refund.create": "deny" }),
          tool: readTool as never,
          payload: {},
        });
      }),
    );
    expect(result).toBe("allow");
  });

  it("returns Effect that requires only the PermissionService Tag", () => {
    const eff = Effect.gen(function* () {
      const perms = yield* PermissionService;
      return yield* perms.check({
        tenantId: TenantId("t1"),
        agent: baseAgent(),
        tool: readTool as never,
        payload: {},
      });
    });
    const provided: Effect.Effect<"allow" | "ask" | "deny", never, never> =
      Effect.provide(eff, PermissionServiceDefault);
    // Stress the compiler — if the env leaks beyond PermissionService this
    // assignment fails to typecheck.
    expect(typeof provided).toBe("object");
  });

  // sanity: default layer is a Layer<PermissionService>
  it("PermissionServiceDefault has the expected layer shape", () => {
    const _l: Layer.Layer<PermissionService> = PermissionServiceDefault;
    expect(typeof _l).toBe("object");
  });
});
