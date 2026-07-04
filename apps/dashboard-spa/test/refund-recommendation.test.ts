import { describe, expect, it } from "vitest";
import {
  extractRefundRecommendation,
  issuableRefund,
  refundAlreadyIssued,
  refundRecommendationFromEntry,
} from "../lib/refund-recommendation";

const recommendEntry = (
  recommendation: string,
  amount: { amount: string; currencyCode: string } | null,
) => ({
  action: "tool.invoked",
  details: {
    tool: "refund.recommend",
    output: { recommendation, amount, reasoning: "", riskFlags: [] },
  },
});

describe("refund recommendation timeline helpers", () => {
  it("extracts a structured refund.recommend output from an audit entry", () => {
    const out = refundRecommendationFromEntry({
      action: "tool.invoked",
      details: {
        tool: "refund.recommend",
        ok: true,
        output: {
          recommendation: "full_refund",
          amount: { amount: "20.00", currencyCode: "USD" },
          reasoning: "Within return window.",
          riskFlags: ["first_order"],
        },
      },
    });

    expect(out).toEqual({
      recommendation: "full_refund",
      amount: { amount: "20.00", currencyCode: "USD" },
      reasoning: "Within return window.",
      riskFlags: ["first_order"],
    });
  });

  it("uses the latest recommendation when a ticket was re-run", () => {
    const out = extractRefundRecommendation([
      {
        action: "tool.invoked",
        details: {
          tool: "refund.recommend",
          output: {
            recommendation: "investigate",
            amount: null,
            reasoning: "Old recommendation.",
            riskFlags: [],
          },
        },
      },
      {
        action: "tool.invoked",
        details: {
          tool: "refund.recommend",
          output: {
            recommendation: "deny",
            amount: null,
            reasoning: "Newer recommendation.",
            riskFlags: ["frequent_refunder"],
          },
        },
      },
    ]);

    expect(out?.recommendation).toBe("deny");
    expect(out?.reasoning).toBe("Newer recommendation.");
  });
});

describe("issuableRefund — gates the 'Issue refund' button", () => {
  it("offers the recommended refund when it carries a concrete amount", () => {
    const out = issuableRefund([
      recommendEntry("full_refund", { amount: "24.92", currencyCode: "USD" }),
    ]);
    expect(out).toEqual({
      recommendation: "full_refund",
      amount: { amount: "24.92", currencyCode: "USD" },
      reasoning: "",
      riskFlags: [],
    });
  });

  it("offers nothing when the recommendation has no amount (deny / no-amount investigate)", () => {
    expect(issuableRefund([recommendEntry("deny", null)])).toBeNull();
    expect(issuableRefund([recommendEntry("investigate", null)])).toBeNull();
  });

  it("offers nothing once a refund has already been issued on the ticket", () => {
    const entries = [
      recommendEntry("full_refund", { amount: "24.92", currencyCode: "USD" }),
      { action: "ticket.refund_issued", details: { refundId: "r1" } },
    ];
    expect(refundAlreadyIssued(entries)).toBe(true);
    expect(issuableRefund(entries)).toBeNull();
  });

  it("reports no prior refund when none was issued", () => {
    expect(
      refundAlreadyIssued([
        recommendEntry("full_refund", { amount: "5.00", currencyCode: "USD" }),
      ]),
    ).toBe(false);
  });
});
