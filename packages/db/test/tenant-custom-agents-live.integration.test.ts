import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { makeDbClient, tenantCustomAgents, tenants } from "../src/index.js";

// Pins the raw DDL the schema generates (migration 0029): the composite PK,
// the status CHECK, the FK cascade, the jsonb defaults, and that the jsonb
// columns round-trip arrays / objects intact. The CustomAgentService Live
// layer (A2) exercises the query surface on top of this; here we hit the table
// directly. Gated on DATABASE_URL (skipped without a DB).
const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("tenant_custom_agents schema", () => {
  const client = makeDbClient({ databaseUrl: databaseUrl! });
  const { db } = client;

  const seededTenants: string[] = [];

  afterAll(async () => {
    if (seededTenants.length > 0) {
      await db.delete(tenants).where(inArray(tenants.id, seededTenants));
    }
    await client.close();
  });

  const seedTenant = async (): Promise<string> => {
    const id = randomUUID();
    await db.insert(tenants).values({ id, name: "Custom Agent Test" });
    seededTenants.push(id);
    return id;
  };

  it("round-trips a full row including jsonb arrays + map", async () => {
    const tenantId = await seedTenant();
    await db.insert(tenantCustomAgents).values({
      tenantId,
      agentId: "custom:roundtrip",
      name: "Returns Concierge",
      description: "Handles return requests.",
      instructions: "Be warm. Look up the order before promising anything.",
      model: "google/gemini-3.5-flash",
      tools: ["shopify.get_order", "conversation.reply"],
      handoffs: ["refund-review-agent"],
      callableFrom: ["support-triage"],
      permissionOverrides: { "conversation.reply": "ask" },
      whenToUse: "Use when the customer wants to start a return.",
      maxTurnsPerTick: 9,
    });

    const [row] = await db
      .select()
      .from(tenantCustomAgents)
      .where(
        and(
          eq(tenantCustomAgents.tenantId, tenantId),
          eq(tenantCustomAgents.agentId, "custom:roundtrip"),
        ),
      );

    expect(row).toBeDefined();
    expect(row!.tools).toEqual(["shopify.get_order", "conversation.reply"]);
    expect(row!.handoffs).toEqual(["refund-review-agent"]);
    expect(row!.callableFrom).toEqual(["support-triage"]);
    expect(row!.permissionOverrides).toEqual({ "conversation.reply": "ask" });
    expect(row!.whenToUse).toBe("Use when the customer wants to start a return.");
    expect(row!.maxTurnsPerTick).toBe(9);
  });

  it("applies jsonb + scalar defaults when omitted", async () => {
    const tenantId = await seedTenant();
    await db.insert(tenantCustomAgents).values({
      tenantId,
      agentId: "custom:defaults",
      name: "Bare",
      description: "Minimal.",
      instructions: "Do the thing.",
      model: "google/gemini-3.5-flash",
    });

    const [row] = await db
      .select()
      .from(tenantCustomAgents)
      .where(eq(tenantCustomAgents.tenantId, tenantId));

    expect(row!.tools).toEqual([]);
    expect(row!.handoffs).toEqual([]);
    expect(row!.callableFrom).toEqual([]);
    expect(row!.permissionOverrides).toEqual({});
    expect(row!.whenToUse).toBeNull();
    expect(row!.maxTurnsPerTick).toBe(6);
    expect(row!.status).toBe("active");
  });

  it("enforces the (tenant_id, agent_id) composite primary key", async () => {
    const tenantId = await seedTenant();
    const base = {
      tenantId,
      agentId: "custom:dup",
      name: "First",
      description: "d",
      instructions: "i",
      model: "google/gemini-3.5-flash",
    };
    await db.insert(tenantCustomAgents).values(base);
    await expect(
      db.insert(tenantCustomAgents).values({ ...base, name: "Second" }),
    ).rejects.toThrow();
  });

  it("rejects a status outside the CHECK set", async () => {
    const tenantId = await seedTenant();
    await expect(
      db.insert(tenantCustomAgents).values({
        tenantId,
        agentId: "custom:badstatus",
        name: "Bad",
        description: "d",
        instructions: "i",
        model: "google/gemini-3.5-flash",
        status: "bogus",
      }),
    ).rejects.toThrow();
  });

  it("cascade-deletes custom agents with their tenant", async () => {
    const tenantId = await seedTenant();
    await db.insert(tenantCustomAgents).values({
      tenantId,
      agentId: "custom:cascade",
      name: "Doomed",
      description: "d",
      instructions: "i",
      model: "google/gemini-3.5-flash",
    });

    await db.delete(tenants).where(eq(tenants.id, tenantId));
    seededTenants.splice(seededTenants.indexOf(tenantId), 1);

    const rows = await db
      .select()
      .from(tenantCustomAgents)
      .where(eq(tenantCustomAgents.tenantId, tenantId));
    expect(rows.length).toBe(0);
  });
});
