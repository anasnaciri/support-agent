import { afterAll, describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { AgentId, TenantId } from "@support-agent/agent-core";
import { TenantAgentOverridesService } from "@support-agent/services";
import {
  DbClientLive,
  makeDbClient,
  tenantAgentOverrides,
  TenantAgentOverridesServiceLive,
  tenants,
} from "../src/index.js";

// Exercises the REAL jsonb SQL the in-memory Test layer can't: the `||` merge
// in setToolPermission and the `- key` / `nullif(…, '{}')` collapse in
// clearToolPermission, plus the field-aware row delete spanning model +
// systemPrompt + toolPermissions. Gated on DATABASE_URL (skipped without a DB).
const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("TenantAgentOverridesServiceLive — tool permissions", () => {
  const client = makeDbClient({ databaseUrl: databaseUrl! });
  const { db } = client;

  afterAll(async () => {
    await client.close();
  });

  const layer = TenantAgentOverridesServiceLive.pipe(
    Layer.provide(DbClientLive({ databaseUrl: databaseUrl! })),
  );

  const agentX = AgentId("support-triage");

  const seedTenant = async (): Promise<TenantId> => {
    const id = randomUUID();
    await db.insert(tenants).values({ id, name: "Tool Perm Test" });
    return TenantId(id);
  };

  it("merges multiple tool permissions into one jsonb map", async () => {
    const tenantId = await seedTenant();
    const map = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const s = yield* TenantAgentOverridesService;
          yield* s.setToolPermission(tenantId, agentX, "conversation.reply", "ask");
          yield* s.setToolPermission(tenantId, agentX, "supplier.add_sheet_row", "allow");
          yield* s.setToolPermission(tenantId, agentX, "conversation.reply", "allow");
          return yield* s.getForTenant(tenantId);
        }),
        layer,
      ),
    );
    expect(map.get(agentX)?.toolPermissions).toEqual({
      "conversation.reply": "allow",
      "supplier.add_sheet_row": "allow",
    });
  });

  it("clearToolPermission drops one key, keeps the rest (row survives)", async () => {
    const tenantId = await seedTenant();
    const map = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const s = yield* TenantAgentOverridesService;
          yield* s.setToolPermission(tenantId, agentX, "conversation.reply", "allow");
          yield* s.setToolPermission(tenantId, agentX, "supplier.add_sheet_row", "allow");
          yield* s.clearToolPermission(tenantId, agentX, "conversation.reply");
          return yield* s.getForTenant(tenantId);
        }),
        layer,
      ),
    );
    expect(map.get(agentX)?.toolPermissions).toEqual({
      "supplier.add_sheet_row": "allow",
    });
  });

  it("clearing the last key collapses the map to NULL and removes the row", async () => {
    const tenantId = await seedTenant();
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const s = yield* TenantAgentOverridesService;
          yield* s.setToolPermission(tenantId, agentX, "conversation.reply", "allow");
          yield* s.clearToolPermission(tenantId, agentX, "conversation.reply");
        }),
        layer,
      ),
    );
    const rows = await db
      .select()
      .from(tenantAgentOverrides)
      .where(eq(tenantAgentOverrides.tenantId, tenantId));
    expect(rows.length).toBe(0);
  });

  it("clearModel keeps tool permissions (field-aware row survives)", async () => {
    const tenantId = await seedTenant();
    const map = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const s = yield* TenantAgentOverridesService;
          yield* s.setModel(tenantId, agentX, "google/gemini-3.5-flash");
          yield* s.setToolPermission(tenantId, agentX, "conversation.reply", "allow");
          yield* s.clearModel(tenantId, agentX);
          return yield* s.getForTenant(tenantId);
        }),
        layer,
      ),
    );
    expect(map.get(agentX)?.model).toBeNull();
    expect(map.get(agentX)?.toolPermissions).toEqual({
      "conversation.reply": "allow",
    });
  });

  it("tool permissions coexist with model + systemPrompt on one row", async () => {
    const tenantId = await seedTenant();
    const map = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const s = yield* TenantAgentOverridesService;
          yield* s.setModel(tenantId, agentX, "google/gemini-3.5-flash");
          yield* s.setSystemPrompt(tenantId, agentX, "Be warm.");
          yield* s.setToolPermission(tenantId, agentX, "conversation.reply", "allow");
          return yield* s.getForTenant(tenantId);
        }),
        layer,
      ),
    );
    const o = map.get(agentX);
    expect(o?.model).toBe("google/gemini-3.5-flash");
    expect(o?.systemPrompt).toBe("Be warm.");
    expect(o?.toolPermissions).toEqual({ "conversation.reply": "allow" });
  });
});
