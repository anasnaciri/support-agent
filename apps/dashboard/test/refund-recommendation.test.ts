import { describe, expect, it } from "vitest";
import {
  extractRefundRecommendation,
  refundRecommendationFromEntry,
} from "../app/cases/[id]/refund-recommendation";

describe("refund recommendation timeline helpers", () => {
  it("extracts a structured refund.recommend output from an audit entry", () => {
    const out = refundRecommendationFromEntry({
      id: 1n,
      action: "tool.invoked",
      occurredAt: new Date("2026-05-26T12:00:00.000Z"),
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

  it("uses the latest recommendation when a case was re-run", () => {
    const out = extractRefundRecommendation([
      {
        id: 1n,
        action: "tool.invoked",
        occurredAt: new Date("2026-05-26T12:00:00.000Z"),
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
        id: 2n,
        action: "tool.invoked",
        occurredAt: new Date("2026-05-26T12:05:00.000Z"),
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
