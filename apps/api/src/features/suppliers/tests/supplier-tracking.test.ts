import { describe, expect, it } from "vitest";
import {
  updateSupplierTracking,
  type SupplierFulfillmentView,
  type UpdateSupplierTrackingOptions,
} from "../supplier-tracking.js";

// Unit tests for the dependency-injected orchestration core (same pattern as
// updateCaseShippingAddress): fulfillment picking + ordering of the Shopify
// write vs the bookkeeping, with fakes for every dep.

const fulfillment = (
  id: string,
  trackingNumbers: ReadonlyArray<string>,
  trackingCompany: string | null = null,
): SupplierFulfillmentView => ({ id, trackingNumbers, trackingCompany });

interface Call {
  readonly fulfillmentId: string;
  readonly trackingNumber: string;
  readonly trackingCompany: string | null;
}

const harness = (overrides: Partial<UpdateSupplierTrackingOptions> = {}) => {
  const updates: Array<Call> = [];
  const recorded: Array<Call> = [];
  const opts: UpdateSupplierTrackingOptions = {
    trackingNumber: "NEW123",
    trackingCompany: null,
    currentTrackingNumber: null,
    loadFulfillments: () =>
      Promise.resolve<ReadonlyArray<SupplierFulfillmentView> | null>([
        fulfillment("gid://shopify/Fulfillment/1", ["OLD1"], "DHL"),
      ]),
    update: (args) => {
      updates.push(args);
      return Promise.resolve({
        trackingNumbers: [args.trackingNumber],
        trackingCompany: args.trackingCompany,
      });
    },
    recordUpdated: (args) => {
      recorded.push(args);
      return Promise.resolve();
    },
    ...overrides,
  };
  return { opts, updates, recorded };
};

describe("updateSupplierTracking — fulfillment picking", () => {
  it("single fulfillment: updates it", async () => {
    const { opts, updates } = harness();
    const outcome = await updateSupplierTracking(opts);
    expect(outcome.kind).toBe("saved");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.fulfillmentId).toBe("gid://shopify/Fulfillment/1");
    expect(updates[0]!.trackingNumber).toBe("NEW123");
  });

  it("multiple fulfillments: picks the one matching the escalation's tracking number", async () => {
    const { opts, updates } = harness({
      currentTrackingNumber: "B2",
      loadFulfillments: () =>
        Promise.resolve([
          fulfillment("gid://shopify/Fulfillment/1", ["A1"]),
          fulfillment("gid://shopify/Fulfillment/2", ["B2"]),
        ]),
    });
    const outcome = await updateSupplierTracking(opts);
    expect(outcome.kind).toBe("saved");
    expect(updates[0]!.fulfillmentId).toBe("gid://shopify/Fulfillment/2");
  });

  it("multiple fulfillments and no tracking match: ambiguous_fulfillment, no write", async () => {
    const { opts, updates } = harness({
      currentTrackingNumber: "ZZZ",
      loadFulfillments: () =>
        Promise.resolve([
          fulfillment("gid://shopify/Fulfillment/1", ["A1"]),
          fulfillment("gid://shopify/Fulfillment/2", ["B2"]),
        ]),
    });
    const outcome = await updateSupplierTracking(opts);
    expect(outcome.kind).toBe("ambiguous_fulfillment");
    expect(updates).toHaveLength(0);
  });

  it("no fulfillments: no_fulfillment, no write", async () => {
    const { opts, updates } = harness({
      loadFulfillments: () => Promise.resolve([]),
    });
    const outcome = await updateSupplierTracking(opts);
    expect(outcome.kind).toBe("no_fulfillment");
    expect(updates).toHaveLength(0);
  });

  it("order unresolvable: order_not_found, no write", async () => {
    const { opts, updates } = harness({
      loadFulfillments: () => Promise.resolve(null),
    });
    const outcome = await updateSupplierTracking(opts);
    expect(outcome.kind).toBe("order_not_found");
    expect(updates).toHaveLength(0);
  });
});

describe("updateSupplierTracking — carrier handling", () => {
  it("passes the supplied carrier through", async () => {
    const { opts, updates } = harness({ trackingCompany: "UPS" });
    await updateSupplierTracking(opts);
    expect(updates[0]!.trackingCompany).toBe("UPS");
  });

  it("carries over the fulfillment's current carrier when none is supplied", async () => {
    const { opts, updates } = harness({ trackingCompany: null });
    await updateSupplierTracking(opts);
    // The single fixture fulfillment ships DHL; replacing the number must not
    // silently drop the carrier (Shopify derives the tracking URL from it).
    expect(updates[0]!.trackingCompany).toBe("DHL");
  });

  it("saved outcome reports what Shopify stored", async () => {
    const { opts } = harness({
      trackingCompany: "UPS",
      update: () =>
        Promise.resolve({
          trackingNumbers: ["NEW123"],
          trackingCompany: "UPS",
        }),
    });
    const outcome = await updateSupplierTracking(opts);
    expect(outcome).toEqual({
      kind: "saved",
      trackingNumber: "NEW123",
      trackingCompany: "UPS",
    });
  });
});

describe("updateSupplierTracking — failure ordering", () => {
  it("a failed store write maps to update_failed and skips bookkeeping", async () => {
    const { opts, recorded } = harness({
      update: () => Promise.reject(new Error("tracking update rejected: nope")),
    });
    const outcome = await updateSupplierTracking(opts);
    expect(outcome).toEqual({
      kind: "update_failed",
      error: "tracking update rejected: nope",
    });
    expect(recorded).toHaveLength(0);
  });

  it("bookkeeping failure never fails a completed store write", async () => {
    const { opts } = harness({
      recordUpdated: () => Promise.reject(new Error("db down")),
    });
    const outcome = await updateSupplierTracking(opts);
    expect(outcome.kind).toBe("saved");
  });

  it("bookkeeping receives the picked fulfillment and stored tracking", async () => {
    const { opts, recorded } = harness();
    await updateSupplierTracking(opts);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toEqual({
      fulfillmentId: "gid://shopify/Fulfillment/1",
      trackingNumber: "NEW123",
      trackingCompany: "DHL",
    });
  });
});
