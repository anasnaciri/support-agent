import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { DrizzleDb } from "./client.js";
import { connectorConnections } from "./schema.js";

export interface ShopifyShipmentRolloutCandidate {
  readonly tenantId: string;
  readonly shopDomain: string;
}

export const shopifyShipmentRolloutCandidates = (
  db: DrizzleDb,
  version: string,
): Promise<ReadonlyArray<ShopifyShipmentRolloutCandidate>> =>
  db
    .select({
      tenantId: connectorConnections.tenantId,
      shopDomain: connectorConnections.shopDomain,
    })
    .from(connectorConnections)
    .where(
      and(
        eq(connectorConnections.provider, "shopify"),
        eq(connectorConnections.status, "active"),
        ne(
          sql`coalesce(${connectorConnections.metadata}->'shopifyShipmentRollout'->>'version', '')`,
          version,
        ),
      ),
    )
    .orderBy(
      asc(connectorConnections.tenantId),
      asc(connectorConnections.shopDomain),
    );
