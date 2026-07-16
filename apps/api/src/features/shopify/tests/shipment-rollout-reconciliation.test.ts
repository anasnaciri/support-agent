import { describe, expect, it, vi } from "vitest";
import { TenantId } from "@support-agent/agent-core";
import { reconcileShopifyShipmentRollout } from "../shipment-rollout-reconciliation.js";

describe("reconcileShopifyShipmentRollout", () => {
  it("registers fulfillment webhooks, enqueues a backfill, then marks the connector complete", async () => {
    const calls: string[] = [];
    const target = {
      tenantId: TenantId("11111111-1111-1111-1111-111111111111"),
      shopDomain: "acme.myshopify.com",
      accessToken: "token",
      apiVersion: "2026-04",
      scopes: ["read_fulfillments"],
    };
    const result = await reconcileShopifyShipmentRollout([target], {
      registerWebhooks: vi.fn(async () => {
        calls.push("register");
        return [
          {
            id: "created",
            topic: "FULFILLMENTS_CREATE" as const,
            uri: "https://api.example.com/webhooks/shopify/fulfillments/create",
            status: "created" as const,
          },
          {
            id: "updated",
            topic: "FULFILLMENTS_UPDATE" as const,
            uri: "https://api.example.com/webhooks/shopify/fulfillments/update",
            status: "created" as const,
          },
        ];
      }),
      enqueueBackfill: vi.fn(async () => {
        calls.push("enqueue");
      }),
      markComplete: vi.fn(async () => {
        calls.push("mark");
      }),
    });

    expect(calls).toEqual(["register", "enqueue", "mark"]);
    expect(result).toEqual({
      attempted: 1,
      completed: 1,
      deferred: [],
      failed: [],
    });
  });

  it("defers legacy connectors missing Shopify's fulfillment webhook scope without failing the release", async () => {
    const target = {
      tenantId: TenantId("11111111-1111-1111-1111-111111111111"),
      shopDomain: "legacy.myshopify.com",
      accessToken: "token",
      apiVersion: "2026-04",
      scopes: ["read_orders"],
    };
    const registerWebhooks = vi.fn();
    const enqueueBackfill = vi.fn();
    const markComplete = vi.fn();

    const result = await reconcileShopifyShipmentRollout([target], {
      registerWebhooks,
      enqueueBackfill,
      markComplete,
    });

    expect(registerWebhooks).not.toHaveBeenCalled();
    expect(enqueueBackfill).not.toHaveBeenCalled();
    expect(markComplete).not.toHaveBeenCalled();
    expect(result).toEqual({
      attempted: 1,
      completed: 0,
      deferred: [
        {
          tenantId: "11111111-1111-1111-1111-111111111111",
          shopDomain: "legacy.myshopify.com",
          reason: "missing_read_fulfillments_scope",
        },
      ],
      failed: [],
    });
  });

  it("leaves a failed connector unmarked and continues reconciling the rest", async () => {
    const targets = ["broken", "healthy"].map((name) => ({
      tenantId: TenantId(
        name === "broken"
          ? "11111111-1111-1111-1111-111111111111"
          : "22222222-2222-2222-2222-222222222222",
      ),
      shopDomain: `${name}.myshopify.com`,
      accessToken: "token",
      apiVersion: "2026-04",
      scopes: ["read_fulfillments"],
    }));
    const marked: string[] = [];
    const result = await reconcileShopifyShipmentRollout(targets, {
      registerWebhooks: async (target) => {
        if (target.shopDomain.startsWith("broken")) {
          throw new Error("Shopify unavailable");
        }
        return [];
      },
      enqueueBackfill: async () => undefined,
      markComplete: async (target) => {
        marked.push(target.shopDomain);
      },
    });

    expect(marked).toEqual(["healthy.myshopify.com"]);
    expect(result).toEqual({
      attempted: 2,
      completed: 1,
      deferred: [],
      failed: [
        {
          tenantId: "11111111-1111-1111-1111-111111111111",
          shopDomain: "broken.myshopify.com",
          error: "Shopify unavailable",
        },
      ],
    });
  });
});
