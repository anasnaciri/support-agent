import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  makeDbClient,
  shipments,
  tenants,
} from "@support-agent/db";
import { startServer, type ServerHandle } from "../../../server.js";
import type { ApiConfig } from "../../../bootstrap.js";
import {
  TEST_DASHBOARD_VERIFIER,
  dashboardAuthHeaders,
} from "../../../tests/support/dashboard-auth.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("GET /dashboard/analytics/delivery (integration)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const orgId = `org_${randomUUID().slice(0, 8)}`;
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const start = new Date("2026-07-01T00:00:00.000Z");
  const end = new Date("2026-08-01T00:00:00.000Z");
  const shippedAt = new Date("2026-07-05T00:00:00.000Z");
  const exceptionAt = new Date("2026-07-08T00:00:00.000Z");
  const deliveredAt = new Date("2026-07-10T00:00:00.000Z");
  const cfg = {
    port: 0,
    databaseUrl: databaseUrl!,
    encryptionKey: randomBytes(32),
    stateSigningKey: "delivery-analytics-state",
    shopify: {
      clientId: "client",
      clientSecret: "secret",
      callbackUrl: "http://localhost/shopify/auth/callback",
      apiVersion: "2026-04",
    },
    google: null,
    approvalSigningKey: "delivery-analytics-approval",
    dashboardBaseUrl: null,
    workos: null,
  } as ApiConfig;
  let handle: ServerHandle | null = null;
  let baseUrl = "";

  beforeAll(async () => {
    if (!raw) return;
    await raw.db.insert(tenants).values([
      {
        id: tenantId,
        name: "delivery analytics",
        workosOrganizationId: orgId,
      },
      { id: otherTenantId, name: "other delivery tenant" },
    ]);
    await raw.db.insert(shipments).values([
      {
        tenantId,
        source: "shopify",
        sourceOrderId: "order-1",
        sourceFulfillmentId: "fulfillment-1",
        trackingNumber: "UPS-1",
        carrier: "UPS",
        status: "delivered",
        shippedAt,
        firstExceptionAt: exceptionAt,
        deliveredAt,
        transitDays: 5,
      },
      {
        tenantId,
        source: "shopify",
        sourceOrderId: "order-2",
        sourceFulfillmentId: "fulfillment-2",
        trackingNumber: "UPS-2",
        carrier: "UPS",
        status: "exception",
        shippedAt,
        firstExceptionAt: exceptionAt,
        transitDays: 8,
      },
      {
        tenantId,
        source: "shopify",
        sourceOrderId: "order-3",
        sourceFulfillmentId: "fulfillment-3",
        trackingNumber: "DHL-1",
        carrier: "DHL",
        status: "in_transit",
        shippedAt,
      },
      {
        tenantId,
        source: "shopify",
        sourceOrderId: "order-4",
        sourceFulfillmentId: "fulfillment-4",
        trackingNumber: "DHL-2",
        carrier: "DHL",
        status: "stopped",
        shippedAt,
        trackingStoppedAt: new Date("2026-07-12T00:00:00.000Z"),
      },
      {
        tenantId: otherTenantId,
        source: "shopify",
        sourceOrderId: "other-order",
        sourceFulfillmentId: "other-fulfillment",
        trackingNumber: "OTHER",
        status: "delivered",
        shippedAt,
        deliveredAt,
      },
    ]);
    handle = await startServer(cfg, {
      dashboardTokenVerifier: TEST_DASHBOARD_VERIFIER,
    });
    baseUrl = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    if (!raw) return;
    if (handle) await handle.close();
    for (const id of [tenantId, otherTenantId]) {
      await raw.db.delete(shipments).where(sql`${shipments.tenantId} = ${id}`);
      await raw.db.delete(tenants).where(sql`${tenants.id} = ${id}`);
    }
    await raw.close();
  });

  it("returns tenant-scoped shipment cohort, lifecycle activity, and current state", async () => {
    const params = new URLSearchParams({
      start: start.toISOString(),
      end: end.toISOString(),
    });
    const res = await fetch(
      `${baseUrl}/dashboard/analytics/delivery?${params.toString()}`,
      { headers: dashboardAuthHeaders(orgId) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.cohort.shipmentsCreated).toBe(4);
    expect(body.cohort.deliveryRate).toEqual({
      count: 1,
      total: 4,
      percentage: 25,
    });
    expect(body.cohort.exceptionRate).toEqual({
      count: 2,
      total: 4,
      percentage: 50,
    });
    expect(body.cohort.exceptionRecoveryRate).toEqual({
      count: 1,
      total: 2,
      percentage: 50,
    });
    expect(body.cohort.topCarriers).toEqual([
      {
        carrier: "DHL",
        shipments: 2,
        exceptions: 0,
        exceptionRate: { count: 0, total: 2, percentage: 0 },
      },
      {
        carrier: "UPS",
        shipments: 2,
        exceptions: 2,
        exceptionRate: { count: 2, total: 2, percentage: 100 },
      },
    ]);
    expect(body.activity).toEqual({
      delivered: 1,
      exceptions: 2,
      trackingStopped: 1,
      medianTransitDays: 5,
    });
    expect(body.current).toEqual({
      total: 4,
      inTransit: 1,
      pending: 0,
      exceptions: 1,
      stopped: 1,
      delivered: 1,
    });
  });
});
