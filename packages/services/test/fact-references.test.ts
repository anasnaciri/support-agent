import { describe, expect, it } from "vitest";
import {
  FACT_REFERENCE_CATALOG,
  factReferenceById,
  resolveFactReferences,
} from "../src/fact-references.js";
import {
  TenantSettings,
  defaultRefundPolicy,
  defaultDiscountPolicy,
  DEFAULT_RETENTION_DAYS,
} from "../src/index.js";

const settings = (
  over: Partial<ConstructorParameters<typeof TenantSettings>[0]> = {},
): TenantSettings =>
  new TenantSettings({
    notificationEmail: null,
    refundPolicy: defaultRefundPolicy,
    discountPolicy: defaultDiscountPolicy,
    retentionDays: DEFAULT_RETENTION_DAYS,
    supplierEscalationSheet: null,
    legalAcceptance: null,
    shippingFacts: null,
    returnsFacts: null,
    ...over,
  });

const withReturns = settings({
  returnsFacts: {
    returnWindowDays: 30,
    returnShippingPayer: "customer",
    refundMethod: "original",
    refundProcessingTime: "5–7 business days",
  },
});

describe("factReferenceCatalog", () => {
  it("is single-source: every entry's id is unique and index-consistent", () => {
    const ids = FACT_REFERENCE_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of FACT_REFERENCE_CATALOG) {
      expect(factReferenceById.get(entry.id)).toBe(entry);
    }
  });

  it("carries the fields the design names, plus the read-only enforcement ref", () => {
    const ids = new Set(FACT_REFERENCE_CATALOG.map((e) => e.id));
    expect(ids.has("returns.return_window")).toBe(true);
    expect(ids.has("shipping.delivery_time")).toBe(true);
    expect(ids.has("refunds.approval_threshold")).toBe(true);
  });

  it("gives every entry a non-empty label and neutral fallback phrase", () => {
    for (const entry of FACT_REFERENCE_CATALOG) {
      expect(entry.label.trim().length).toBeGreaterThan(0);
      expect(entry.fallback.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("resolveFactReferences", () => {
  it("substitutes a configured field with its rendered value", () => {
    const { resolved, dangling } = resolveFactReferences(
      "Returns are accepted within @returns.return_window of delivery.",
      withReturns,
    );
    expect(resolved).toContain("30 days");
    expect(resolved).not.toContain("@returns.return_window");
    expect(dangling).toEqual([]);
  });

  it("substitutes the fallback AND flags dangling when the field is unset", () => {
    // Author the ref before filling the field (or clear the field after) —
    // same null state, same rule.
    const { resolved, dangling } = resolveFactReferences(
      "Returns are accepted within @returns.return_window of delivery.",
      settings({ returnsFacts: null }),
    );
    expect(resolved).not.toContain("@returns.return_window");
    // The neutral fallback phrase stands in, so the sentence still reads.
    const fallback = factReferenceById.get("returns.return_window")!.fallback;
    expect(resolved).toContain(fallback);
    expect(dangling).toContain("returns.return_window");
  });

  it("leaves an email address verbatim and never flags it dangling", () => {
    const { resolved, dangling } = resolveFactReferences(
      "Email us at help@store.com or sales@shop.io.",
      withReturns,
    );
    expect(resolved).toBe("Email us at help@store.com or sales@shop.io.");
    expect(dangling).toEqual([]);
  });

  it("flags a typo'd ref in a KNOWN namespace as dangling but leaves it verbatim", () => {
    // Unknown id under a known namespace is a mistake, not an email — the
    // merchant should see a warning, but we can't invent a substitution.
    const { resolved, dangling } = resolveFactReferences(
      "See @returns.no_such_field for details.",
      withReturns,
    );
    expect(resolved).toContain("@returns.no_such_field");
    expect(dangling).toContain("returns.no_such_field");
  });

  it("resolves a whole-block @namespace summary", () => {
    const { resolved } = resolveFactReferences(
      "Our policy: @returns",
      withReturns,
    );
    expect(resolved).not.toMatch(/@returns\b/);
    expect(resolved).toContain("30 days");
  });

  it("renders the read-only refund threshold from the refund policy", () => {
    const { resolved, dangling } = resolveFactReferences(
      "Refunds: @refunds.approval_threshold",
      settings({
        refundPolicy: { ...defaultRefundPolicy, mode: "always_ask" },
      }),
    );
    expect(resolved).not.toContain("@refunds.approval_threshold");
    expect(resolved.toLowerCase()).toContain("approval");
    expect(dangling).toEqual([]);
  });

  it("turns a knowledge-doc reference into a knowledge.search instruction without inlining the doc", () => {
    const { resolved, dangling } = resolveFactReferences(
      "For international orders, follow @docs.123e4567-e89b-12d3-a456-426614174000.",
      withReturns,
      [
        {
          id: "123e4567-e89b-12d3-a456-426614174000",
          title: "International shipping policy",
        },
      ],
    );
    expect(resolved).toContain("knowledge.search");
    expect(resolved).toContain("International shipping policy");
    expect(resolved).not.toContain("@docs.");
    expect(resolved).not.toContain("International shipments usually arrive");
    expect(dangling).toEqual([]);
  });

  it("is a no-op on text with no references", () => {
    const text = "Just plain guidance with no tokens.";
    expect(resolveFactReferences(text, withReturns)).toEqual({
      resolved: text,
      dangling: [],
    });
  });

  it("tolerates null settings by falling back on every ref", () => {
    const { resolved, dangling } = resolveFactReferences(
      "Window: @returns.return_window",
      null,
    );
    expect(resolved).not.toContain("@returns.return_window");
    expect(dangling).toContain("returns.return_window");
  });
});
