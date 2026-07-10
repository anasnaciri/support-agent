import { describe, expect, it, vi } from "vitest";
import {
  cancelTicketOrder,
  parseCancelOrderBody,
  type CancelOrderRequest,
  type CancelTicketOrderOrderView,
} from "../ticket-cancel-order.js";

const openOrder: CancelTicketOrderOrderView = {
  orderId: "gid://shopify/Order/1001",
  cancelledAt: null,
};

const request: CancelOrderRequest = {
  refund: true,
  restock: true,
  reason: "customer",
  staffNote: null,
};

const accepted = async () => ({ jobId: "gid://shopify/Job/7", accepted: true });

describe("cancelTicketOrder — operator cancels the ticket's order", () => {
  it("cancels through Shopify and records the audit", async () => {
    const cancel = vi.fn(accepted);
    const recordCancelled = vi.fn(async () => {});

    const outcome = await cancelTicketOrder({
      request,
      loadOrder: async () => openOrder,
      cancel,
      recordCancelled,
    });

    expect(outcome).toEqual({
      kind: "cancelled",
      orderId: "gid://shopify/Order/1001",
      jobId: "gid://shopify/Job/7",
      accepted: true,
    });
    expect(cancel).toHaveBeenCalledWith({
      orderId: "gid://shopify/Order/1001",
      request,
    });
    expect(recordCancelled).toHaveBeenCalledWith({
      orderId: "gid://shopify/Order/1001",
      jobId: "gid://shopify/Job/7",
      request,
    });
  });

  it("passes the operator's refund / restock choices straight through", async () => {
    const cancel = vi.fn(accepted);
    const keepTheMoney: CancelOrderRequest = {
      refund: false,
      restock: false,
      reason: "fraud",
      staffNote: "Chargeback opened",
    };

    await cancelTicketOrder({
      request: keepTheMoney,
      loadOrder: async () => openOrder,
      cancel,
      recordCancelled: async () => {},
    });

    expect(cancel).toHaveBeenCalledWith({
      orderId: "gid://shopify/Order/1001",
      request: keepTheMoney,
    });
  });

  it("returns order_not_found when the ticket has no resolvable order", async () => {
    const cancel = vi.fn(accepted);
    const outcome = await cancelTicketOrder({
      request,
      loadOrder: async () => null,
      cancel,
      recordCancelled: async () => {},
    });
    expect(outcome).toEqual({ kind: "order_not_found" });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("never cancels an already-cancelled order twice", async () => {
    const cancel = vi.fn(accepted);
    const outcome = await cancelTicketOrder({
      request,
      loadOrder: async () => ({
        ...openOrder,
        cancelledAt: "2026-07-01T10:00:00.000Z",
      }),
      cancel,
      recordCancelled: async () => {},
    });
    expect(outcome).toEqual({ kind: "already_cancelled" });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("maps a Shopify rejection to cancel_failed and skips the audit", async () => {
    const recordCancelled = vi.fn(async () => {});
    const outcome = await cancelTicketOrder({
      request,
      loadOrder: async () => openOrder,
      cancel: async () => {
        throw new Error("Order has been fulfilled and cannot be cancelled");
      },
      recordCancelled,
    });
    expect(outcome).toEqual({
      kind: "cancel_failed",
      error: "Order has been fulfilled and cannot be cancelled",
    });
    expect(recordCancelled).not.toHaveBeenCalled();
  });

  it("treats a non-accepted Shopify response as a failure, not a success", async () => {
    // Defensive: the Live impl maps `orderCancelUserErrors` to a thrown
    // ShopifyError, but a false `accepted` must never be reported to the
    // operator as a cancelled order.
    const recordCancelled = vi.fn(async () => {});
    const outcome = await cancelTicketOrder({
      request,
      loadOrder: async () => openOrder,
      cancel: async () => ({ jobId: null, accepted: false }),
      recordCancelled,
    });
    expect(outcome.kind).toBe("cancel_failed");
    expect(recordCancelled).not.toHaveBeenCalled();
  });

  it("never downgrades a real cancellation over an audit hiccup", async () => {
    const outcome = await cancelTicketOrder({
      request,
      loadOrder: async () => openOrder,
      cancel: accepted,
      recordCancelled: async () => {
        throw new Error("audit db down");
      },
    });
    expect(outcome.kind).toBe("cancelled");
  });
});

describe("parseCancelOrderBody — wire values → cancel request", () => {
  it("defaults to refunding and restocking a customer-requested cancel", () => {
    expect(parseCancelOrderBody({})).toEqual({
      refund: true,
      restock: true,
      reason: "customer",
      staffNote: null,
    });
  });

  it("honors an explicit false for refund and restock", () => {
    expect(parseCancelOrderBody({ refund: false, restock: false })).toEqual({
      refund: false,
      restock: false,
      reason: "customer",
      staffNote: null,
    });
  });

  it("accepts every Shopify cancel reason", () => {
    for (const reason of [
      "customer",
      "declined",
      "fraud",
      "inventory",
      "staff",
      "other",
    ] as const) {
      expect(parseCancelOrderBody({ reason })?.reason).toBe(reason);
    }
  });

  it("rejects a reason Shopify does not accept", () => {
    expect(parseCancelOrderBody({ reason: "because" })).toBeNull();
    expect(parseCancelOrderBody({ reason: 7 })).toBeNull();
  });

  it("trims a staff note and maps a blank one to null", () => {
    expect(parseCancelOrderBody({ staffNote: "  duplicate order " })?.staffNote).toBe(
      "duplicate order",
    );
    expect(parseCancelOrderBody({ staffNote: "   " })?.staffNote).toBeNull();
    expect(parseCancelOrderBody({ staffNote: 12 })?.staffNote).toBeNull();
  });

  it("ignores a non-boolean refund flag rather than cancelling without a refund", () => {
    // A malformed `refund` must fail SAFE for the customer: they get their
    // money back. Only an explicit `false` keeps it.
    expect(parseCancelOrderBody({ refund: "no" })?.refund).toBe(true);
  });
});
