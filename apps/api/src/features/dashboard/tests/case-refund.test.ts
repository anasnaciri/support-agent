import { describe, expect, it, vi } from "vitest";
import {
  issueCaseRefund,
  type IssueRefundOrderView,
  type IssuedRefund,
} from "../case-refund.js";

const order = (
  over: Partial<IssueRefundOrderView> = {},
): IssueRefundOrderView => ({
  orderId: "gid://shopify/Order/1001",
  currencyCode: "USD",
  financialStatus: "paid",
  ...over,
});

const issued: IssuedRefund = {
  id: "gid://shopify/Refund/55",
  amount: { amount: "24.92", currencyCode: "USD" },
  createdAt: "2026-06-24T15:00:00.000Z",
};

describe("issueCaseRefund — operator issues an agent-recommended refund", () => {
  it("resolves the order, issues the refund, records it, and returns the refund id", async () => {
    const refund = vi.fn(async () => issued);
    const recordIssued = vi.fn(async () => {});

    const outcome = await issueCaseRefund({
      amount: { amount: "24.92", currencyCode: "USD" },
      loadOrder: async () => order(),
      refund,
      recordIssued,
    });

    expect(outcome).toEqual({
      kind: "issued",
      refundId: "gid://shopify/Refund/55",
      amount: { amount: "24.92", currencyCode: "USD" },
      createdAt: "2026-06-24T15:00:00.000Z",
    });
    expect(refund).toHaveBeenCalledWith({
      orderId: "gid://shopify/Order/1001",
      amount: { amount: "24.92", currencyCode: "USD" },
    });
    expect(recordIssued).toHaveBeenCalledWith(issued);
  });

  it("rejects a non-positive / unparseable amount without resolving the order", async () => {
    const loadOrder = vi.fn(async () => order());
    const refund = vi.fn(async () => issued);

    for (const bad of ["0", "0.00", "-5.00", "", "abc"]) {
      const outcome = await issueCaseRefund({
        amount: { amount: bad, currencyCode: "USD" },
        loadOrder,
        refund,
        recordIssued: async () => {},
      });
      expect(outcome).toEqual({ kind: "invalid_amount" });
    }
    expect(loadOrder).not.toHaveBeenCalled();
    expect(refund).not.toHaveBeenCalled();
  });

  it("returns order_not_found when the case has no resolvable order", async () => {
    const refund = vi.fn(async () => issued);
    const outcome = await issueCaseRefund({
      amount: { amount: "24.92", currencyCode: "USD" },
      loadOrder: async () => null,
      refund,
      recordIssued: async () => {},
    });
    expect(outcome).toEqual({ kind: "order_not_found" });
    expect(refund).not.toHaveBeenCalled();
  });

  it("refuses when the order is already fully refunded", async () => {
    const refund = vi.fn(async () => issued);
    const outcome = await issueCaseRefund({
      amount: { amount: "24.92", currencyCode: "USD" },
      loadOrder: async () => order({ financialStatus: "refunded" }),
      refund,
      recordIssued: async () => {},
    });
    expect(outcome).toEqual({ kind: "already_refunded" });
    expect(refund).not.toHaveBeenCalled();
  });

  it("refuses a currency that doesn't match the order (no FX invented)", async () => {
    const refund = vi.fn(async () => issued);
    const outcome = await issueCaseRefund({
      amount: { amount: "24.92", currencyCode: "EUR" },
      loadOrder: async () => order({ currencyCode: "USD" }),
      refund,
      recordIssued: async () => {},
    });
    expect(outcome).toEqual({
      kind: "currency_mismatch",
      orderCurrency: "USD",
      requestedCurrency: "EUR",
    });
    expect(refund).not.toHaveBeenCalled();
  });

  it("reports refund_failed (and skips bookkeeping) when the Shopify call throws", async () => {
    const recordIssued = vi.fn(async () => {});
    const outcome = await issueCaseRefund({
      amount: { amount: "24.92", currencyCode: "USD" },
      loadOrder: async () => order(),
      refund: async () => {
        throw new Error("RefundFailed");
      },
      recordIssued,
    });
    expect(outcome).toEqual({ kind: "refund_failed", error: "RefundFailed" });
    expect(recordIssued).not.toHaveBeenCalled();
  });

  it("still reports issued when post-refund bookkeeping fails (money already moved)", async () => {
    const outcome = await issueCaseRefund({
      amount: { amount: "24.92", currencyCode: "USD" },
      loadOrder: async () => order(),
      refund: async () => issued,
      recordIssued: async () => {
        throw new Error("audit write failed");
      },
    });
    expect(outcome).toEqual({
      kind: "issued",
      refundId: "gid://shopify/Refund/55",
      amount: { amount: "24.92", currencyCode: "USD" },
      createdAt: "2026-06-24T15:00:00.000Z",
    });
  });
});
