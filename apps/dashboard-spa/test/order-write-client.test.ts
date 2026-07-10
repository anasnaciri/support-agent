import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api-client";
import { ApiError } from "@/lib/errors";

// `apiBase()` reads this at call time and throws without it.
beforeAll(() => {
  import.meta.env.VITE_API_BASE_URL = "http://api.test";
});

const ctx = { workspaceId: "w1" };
const input = {
  refund: true,
  restock: true,
  reason: "customer" as const,
  staffNote: null,
};

const respondWith = (status: number, body: unknown) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      status,
      ok: status >= 200 && status < 300,
      text: async () => (body === undefined ? "" : JSON.stringify(body)),
    })),
  );

afterEach(() => vi.unstubAllGlobals());

describe("api.cancelOrder — outcomes the operator must actually see", () => {
  it("passes a successful cancellation through", async () => {
    respondWith(200, {
      kind: "cancelled",
      orderId: "gid://shopify/Order/1001",
      jobId: "gid://shopify/Job/7",
    });
    const outcome = await api.cancelOrder(ctx, "t1", input);
    expect(outcome.kind).toBe("cancelled");
  });

  it("returns already_cancelled (409) rather than throwing", async () => {
    respondWith(409, { kind: "already_cancelled" });
    await expect(api.cancelOrder(ctx, "t1", input)).resolves.toEqual({
      kind: "already_cancelled",
    });
  });

  it("recovers a Shopify refusal (502) as cancel_failed, not a generic throw", async () => {
    // Regression: `call` throws on >=500, which would have sent this through
    // the mutation's onError and shown "Something went wrong" — hiding the
    // fact that nothing was cancelled and no money moved.
    respondWith(502, { kind: "cancel_failed", error: "already fulfilled" });
    await expect(api.cancelOrder(ctx, "t1", input)).resolves.toEqual({
      kind: "cancel_failed",
    });
  });

  it("still throws on a genuine server fault (500)", async () => {
    respondWith(500, { error: "boom" });
    await expect(api.cancelOrder(ctx, "t1", input)).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});

const money = { amount: "10.00", currencyCode: "EUR" };

describe("api.issueRefund — outcomes the operator must actually see", () => {
  it("passes a successful refund through", async () => {
    respondWith(200, { kind: "issued", refundId: "gid://shopify/Refund/1" });
    const outcome = await api.issueRefund(ctx, "t1", money);
    expect(outcome.kind).toBe("issued");
  });

  it("returns already_refunded (409) rather than throwing", async () => {
    respondWith(409, { kind: "already_refunded" });
    await expect(api.issueRefund(ctx, "t1", money)).resolves.toEqual({
      kind: "already_refunded",
    });
  });

  it("recovers a Shopify refusal (502) as refund_failed, not a generic throw", async () => {
    // Same defect the cancel path had: `call` throws on >=500, so the
    // "No money moved" copy never reached the operator — the toast said
    // "Something went wrong", which reads as "the refund may have happened".
    respondWith(502, { kind: "refund_failed", error: "refund declined" });
    await expect(api.issueRefund(ctx, "t1", money)).resolves.toEqual({
      kind: "refund_failed",
    });
  });

  it("still throws on a genuine server fault (500)", async () => {
    respondWith(500, { error: "boom" });
    await expect(api.issueRefund(ctx, "t1", money)).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});
