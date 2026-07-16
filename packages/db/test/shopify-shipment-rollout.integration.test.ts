import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  connectorConnections,
  makeDbClient,
  shopifyShipmentRolloutCandidates,
  tenants,
} from "../src/index.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("shopifyShipmentRolloutCandidates (integration)", () => {
  const raw = makeDbClient({ databaseUrl: databaseUrl! });
  const tenantIds = [randomUUID(), randomUUID(), randomUUID()];

  afterAll(async () => {
    for (const tenantId of tenantIds) {
      await raw.db.delete(tenants).where(eq(tenants.id, tenantId));
    }
    await raw.close();
  });

  it("returns only active Shopify connectors missing the requested rollout version", async () => {
    await raw.db.insert(tenants).values(
      tenantIds.map((id, index) => ({ id, name: `rollout-${index}` })),
    );
    await raw.db.insert(connectorConnections).values([
      {
        id: randomUUID(),
        tenantId: tenantIds[0]!,
        provider: "shopify",
        shopDomain: "pending.myshopify.com",
        accessTokenEncrypted: Buffer.from("pending"),
        status: "active",
      },
      {
        id: randomUUID(),
        tenantId: tenantIds[1]!,
        provider: "shopify",
        shopDomain: "complete.myshopify.com",
        accessTokenEncrypted: Buffer.from("complete"),
        status: "active",
        metadata: {
          shopifyShipmentRollout: { version: "shipment-analytics-v1" },
        },
      },
      {
        id: randomUUID(),
        tenantId: tenantIds[2]!,
        provider: "shopify",
        shopDomain: "revoked.myshopify.com",
        accessTokenEncrypted: Buffer.from("revoked"),
        status: "revoked",
      },
    ]);

    const candidates = await shopifyShipmentRolloutCandidates(
      raw.db,
      "shipment-analytics-v1",
    );
    expect(
      candidates.filter((candidate) =>
        tenantIds.includes(candidate.tenantId),
      ),
    ).toEqual([
      {
        tenantId: tenantIds[0],
        shopDomain: "pending.myshopify.com",
      },
    ]);
  });
});
