import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { AgentId, TenantId } from "@support-agent/agent-core";
import {
  CustomAgentNotFound,
  CustomAgentService,
  CustomAgentServiceTest,
  DuplicateCustomAgentName,
  type CustomAgentInput,
  type CustomAgentRecord,
  CUSTOM_AGENT_ID_PREFIX,
  isCustomAgentId,
} from "../src/index.js";

const tenantA = TenantId("tenant-a");
const tenantB = TenantId("tenant-b");

const input = (over: Partial<CustomAgentInput> = {}): CustomAgentInput => ({
  name: "Returns Concierge",
  description: "Handles returns.",
  instructions: "Be warm.",
  model: "google/gemini-3.5-flash",
  tools: ["shopify.get_order", "conversation.reply"],
  handoffs: [],
  callableFrom: ["support-triage"],
  permissionOverrides: { "conversation.reply": "ask" },
  whenToUse: "When the customer wants a return.",
  maxTurnsPerTick: 8,
  status: "active",
  ...over,
});

const seededRecord = (
  agentId: string,
  over: Partial<CustomAgentRecord> = {},
): CustomAgentRecord => ({
  agentId: AgentId(agentId),
  name: "Seed",
  description: "d",
  instructions: "i",
  model: "google/gemini-3.5-flash",
  tools: [],
  handoffs: [],
  callableFrom: [],
  permissionOverrides: {},
  whenToUse: null,
  maxTurnsPerTick: 6,
  status: "active",
  createdAt: new Date("2026-06-01"),
  updatedAt: new Date("2026-06-01"),
  ...over,
});

const run = <A, E>(eff: Effect.Effect<A, E, CustomAgentService>, layer = CustomAgentServiceTest()) =>
  Effect.runPromise(Effect.provide(eff, layer));

describe("isCustomAgentId", () => {
  it("recognises the reserved prefix", () => {
    expect(isCustomAgentId(`${CUSTOM_AGENT_ID_PREFIX}abc`)).toBe(true);
    expect(isCustomAgentId("support-triage")).toBe(false);
  });
});

describe("CustomAgentServiceTest", () => {
  it("create assigns a custom: id and round-trips the input", async () => {
    const rec = await run(
      Effect.gen(function* () {
        const svc = yield* CustomAgentService;
        return yield* svc.create(tenantA, input());
      }),
    );
    expect(isCustomAgentId(rec.agentId)).toBe(true);
    expect(rec.name).toBe("Returns Concierge");
    expect(rec.tools).toEqual(["shopify.get_order", "conversation.reply"]);
    expect(rec.callableFrom).toEqual([AgentId("support-triage")]);
    expect(rec.permissionOverrides).toEqual({ "conversation.reply": "ask" });
  });

  it("tryResolve returns an active agent and null for a wrong tenant", async () => {
    const layer = CustomAgentServiceTest([
      { tenantId: tenantA, record: seededRecord("custom:x") },
    ]);
    const [mine, theirs] = await run(
      Effect.gen(function* () {
        const svc = yield* CustomAgentService;
        const a = yield* svc.tryResolve(tenantA, AgentId("custom:x"));
        const b = yield* svc.tryResolve(tenantB, AgentId("custom:x"));
        return [a, b] as const;
      }),
      layer,
    );
    expect(mine?.agentId).toBe(AgentId("custom:x"));
    expect(theirs).toBeNull();
  });

  it("tryResolve returns null for draft/disabled agents", async () => {
    const layer = CustomAgentServiceTest([
      { tenantId: tenantA, record: seededRecord("custom:draft", { status: "draft" }) },
      { tenantId: tenantA, record: seededRecord("custom:off", { status: "disabled" }) },
    ]);
    const [draft, off] = await run(
      Effect.gen(function* () {
        const svc = yield* CustomAgentService;
        return [
          yield* svc.tryResolve(tenantA, AgentId("custom:draft")),
          yield* svc.tryResolve(tenantA, AgentId("custom:off")),
        ] as const;
      }),
      layer,
    );
    expect(draft).toBeNull();
    expect(off).toBeNull();
  });

  it("listForTenant returns only this tenant's active agents", async () => {
    const layer = CustomAgentServiceTest([
      { tenantId: tenantA, record: seededRecord("custom:a1") },
      { tenantId: tenantA, record: seededRecord("custom:a2", { status: "draft" }) },
      { tenantId: tenantB, record: seededRecord("custom:b1") },
    ]);
    const ids = await run(
      Effect.gen(function* () {
        const svc = yield* CustomAgentService;
        const rows = yield* svc.listForTenant(tenantA);
        return rows.map((r) => r.agentId);
      }),
      layer,
    );
    expect(ids).toEqual([AgentId("custom:a1")]);
  });

  it("get returns a draft agent (status-agnostic) for the edit form", async () => {
    const layer = CustomAgentServiceTest([
      { tenantId: tenantA, record: seededRecord("custom:draft", { status: "draft" }) },
    ]);
    const rec = await run(
      Effect.gen(function* () {
        const svc = yield* CustomAgentService;
        return yield* svc.get(tenantA, AgentId("custom:draft"));
      }),
      layer,
    );
    expect(rec?.status).toBe("draft");
  });

  it("update replaces editable fields and keeps createdAt", async () => {
    const layer = CustomAgentServiceTest([
      { tenantId: tenantA, record: seededRecord("custom:x") },
    ]);
    const rec = await run(
      Effect.gen(function* () {
        const svc = yield* CustomAgentService;
        return yield* svc.update(
          tenantA,
          AgentId("custom:x"),
          input({ name: "Renamed" }),
        );
      }),
      layer,
    );
    expect(rec.name).toBe("Renamed");
    expect(rec.createdAt).toEqual(new Date("2026-06-01"));
  });

  it("update fails CustomAgentNotFound for an unknown id", async () => {
    const err = await run(
      Effect.gen(function* () {
        const svc = yield* CustomAgentService;
        return yield* svc.update(tenantA, AgentId("custom:missing"), input()).pipe(
          Effect.flip,
        );
      }),
    );
    expect(err).toBeInstanceOf(CustomAgentNotFound);
  });

  it("create rejects a duplicate name (case-insensitive)", async () => {
    const err = await run(
      Effect.gen(function* () {
        const svc = yield* CustomAgentService;
        yield* svc.create(tenantA, input({ name: "Returns Desk" }));
        return yield* svc
          .create(tenantA, input({ name: "returns DESK" }))
          .pipe(Effect.flip);
      }),
    );
    expect(err).toBeInstanceOf(DuplicateCustomAgentName);
  });

  it("create allows the same name in a different tenant", async () => {
    const ok = await run(
      Effect.gen(function* () {
        const svc = yield* CustomAgentService;
        yield* svc.create(tenantA, input({ name: "Returns Desk" }));
        return yield* svc.create(tenantB, input({ name: "Returns Desk" }));
      }),
    );
    expect(ok.name).toBe("Returns Desk");
  });

  it("update rejects renaming onto another agent's name but allows its own", async () => {
    const result = await run(
      Effect.gen(function* () {
        const svc = yield* CustomAgentService;
        const a = yield* svc.create(tenantA, input({ name: "Alpha" }));
        yield* svc.create(tenantA, input({ name: "Beta" }));
        // Renaming Alpha → Beta collides.
        const collide = yield* svc
          .update(tenantA, a.agentId, input({ name: "Beta" }))
          .pipe(Effect.flip);
        // Re-saving Alpha with its own name is fine.
        const same = yield* svc.update(
          tenantA,
          a.agentId,
          input({ name: "Alpha", description: "edited" }),
        );
        return { collide, same };
      }),
    );
    expect(result.collide).toBeInstanceOf(DuplicateCustomAgentName);
    expect(result.same.description).toBe("edited");
  });

  it("delete removes the agent so tryResolve misses", async () => {
    const layer = CustomAgentServiceTest([
      { tenantId: tenantA, record: seededRecord("custom:x") },
    ]);
    const after = await run(
      Effect.gen(function* () {
        const svc = yield* CustomAgentService;
        yield* svc.delete(tenantA, AgentId("custom:x"));
        return yield* svc.tryResolve(tenantA, AgentId("custom:x"));
      }),
      layer,
    );
    expect(after).toBeNull();
  });
});
