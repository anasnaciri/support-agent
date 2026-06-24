import { afterAll, describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { AgentId, TenantId } from "@support-agent/agent-core";
import {
  CustomAgentNotFound,
  CustomAgentService,
  DuplicateCustomAgentName,
  type CustomAgentInput,
  isCustomAgentId,
} from "@support-agent/services";
import { DbClientLive, makeDbClient, tenants } from "../src/index.js";
import { CustomAgentServiceLive } from "../src/custom-agent-service-live.js";

// Exercises the real SQL the in-memory Test layer can't: the jsonb columns
// round-tripping through Postgres, status filtering on tryResolve/listForTenant,
// the RETURNING on create/update, and CustomAgentNotFound on update of a
// missing row. Gated on DATABASE_URL (skipped without a DB).
const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("CustomAgentServiceLive", () => {
  const client = makeDbClient({ databaseUrl: databaseUrl! });
  const { db } = client;
  const seededTenants: string[] = [];

  afterAll(async () => {
    if (seededTenants.length > 0) {
      await db.delete(tenants).where(inArray(tenants.id, seededTenants));
    }
    await client.close();
  });

  const layer = CustomAgentServiceLive.pipe(
    Layer.provide(DbClientLive({ databaseUrl: databaseUrl! })),
  );

  const run = <A, E>(eff: Effect.Effect<A, E, CustomAgentService>) =>
    Effect.runPromise(Effect.provide(eff, layer));

  const seedTenant = async (): Promise<TenantId> => {
    const id = randomUUID();
    await db.insert(tenants).values({ id, name: "Custom Agent Live Test" });
    seededTenants.push(id);
    return TenantId(id);
  };

  const input = (over: Partial<CustomAgentInput> = {}): CustomAgentInput => ({
    name: "Returns Concierge",
    description: "Handles returns.",
    instructions: "Be warm. Look up the order first.",
    model: "google/gemini-3.5-flash",
    tools: ["shopify.get_order", "conversation.reply"],
    handoffs: ["refund-review-agent"],
    callableFrom: ["support-triage"],
    permissionOverrides: { "conversation.reply": "ask" },
    whenToUse: "When the customer wants a return.",
    maxTurnsPerTick: 8,
    status: "active",
    ...over,
  });

  it("create → tryResolve round-trips through Postgres jsonb", async () => {
    const tenantId = await seedTenant();
    const resolved = await run(
      Effect.gen(function* () {
        const svc = yield* CustomAgentService;
        const created = yield* svc.create(tenantId, input());
        return yield* svc.tryResolve(tenantId, created.agentId);
      }),
    );
    expect(resolved).not.toBeNull();
    expect(isCustomAgentId(resolved!.agentId)).toBe(true);
    expect(resolved!.tools).toEqual(["shopify.get_order", "conversation.reply"]);
    expect(resolved!.handoffs).toEqual([AgentId("refund-review-agent")]);
    expect(resolved!.callableFrom).toEqual([AgentId("support-triage")]);
    expect(resolved!.permissionOverrides).toEqual({ "conversation.reply": "ask" });
  });

  it("tryResolve / listForTenant filter out non-active rows", async () => {
    const tenantId = await seedTenant();
    const result = await run(
      Effect.gen(function* () {
        const svc = yield* CustomAgentService;
        const active = yield* svc.create(tenantId, input({ name: "Active" }));
        const draft = yield* svc.create(
          tenantId,
          input({ name: "Draft", status: "draft" }),
        );
        const resolvedDraft = yield* svc.tryResolve(tenantId, draft.agentId);
        const list = yield* svc.listForTenant(tenantId);
        const getDraft = yield* svc.get(tenantId, draft.agentId);
        return {
          activeId: active.agentId,
          resolvedDraft,
          listIds: list.map((r) => r.agentId),
          getDraftStatus: getDraft?.status,
        };
      }),
    );
    expect(result.resolvedDraft).toBeNull();
    expect(result.listIds).toEqual([result.activeId]);
    expect(result.getDraftStatus).toBe("draft");
  });

  it("update replaces fields + keeps createdAt; delete removes the row", async () => {
    const tenantId = await seedTenant();
    const outcome = await run(
      Effect.gen(function* () {
        const svc = yield* CustomAgentService;
        const created = yield* svc.create(tenantId, input());
        const updated = yield* svc.update(
          tenantId,
          created.agentId,
          input({ name: "Renamed", tools: ["knowledge.search"] }),
        );
        yield* svc.delete(tenantId, created.agentId);
        const afterDelete = yield* svc.tryResolve(tenantId, created.agentId);
        return {
          createdAt: created.createdAt.getTime(),
          updatedCreatedAt: updated.createdAt.getTime(),
          name: updated.name,
          tools: updated.tools,
          afterDelete,
        };
      }),
    );
    expect(outcome.name).toBe("Renamed");
    expect(outcome.tools).toEqual(["knowledge.search"]);
    expect(outcome.updatedCreatedAt).toBe(outcome.createdAt);
    expect(outcome.afterDelete).toBeNull();
  });

  it("update of an unknown id fails CustomAgentNotFound", async () => {
    const tenantId = await seedTenant();
    const err = await run(
      Effect.gen(function* () {
        const svc = yield* CustomAgentService;
        return yield* svc
          .update(tenantId, AgentId("custom:missing"), input())
          .pipe(Effect.flip);
      }),
    );
    expect(err).toBeInstanceOf(CustomAgentNotFound);
  });

  it("create maps the name unique-violation to DuplicateCustomAgentName (case-insensitive)", async () => {
    const tenantId = await seedTenant();
    const err = await run(
      Effect.gen(function* () {
        const svc = yield* CustomAgentService;
        yield* svc.create(tenantId, input({ name: "Returns Desk" }));
        return yield* svc
          .create(tenantId, input({ name: "returns desk" }))
          .pipe(Effect.flip);
      }),
    );
    expect(err).toBeInstanceOf(DuplicateCustomAgentName);
  });

  it("tenant isolation: A's agent never resolves for B", async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    const crossed = await run(
      Effect.gen(function* () {
        const svc = yield* CustomAgentService;
        const created = yield* svc.create(a, input());
        return yield* svc.tryResolve(b, created.agentId);
      }),
    );
    expect(crossed).toBeNull();
  });
});
