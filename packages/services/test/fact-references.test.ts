import { describe, expect, it } from "vitest";
import { toolDisplayName } from "@support-agent/agent-core";
import {
  ACTION_REFERENCE_CATALOG,
  actionReferenceById,
  FACT_REFERENCE_CATALOG,
  factReferenceById,
  resolveFactReferences,
  tokenizeActionReferences,
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

describe("actionReferenceCatalog", () => {
  it("is single-source: ids are unique, indexed, and labelled from TOOL_DISPLAY_NAMES", () => {
    const ids = ACTION_REFERENCE_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of ACTION_REFERENCE_CATALOG) {
      expect(actionReferenceById.get(entry.id)).toBe(entry);
      // The merchant-facing name has ONE home (agent-core) — the `/` menu is a
      // view of it, never a second copy that can drift.
      expect(entry.label).toBe(toolDisplayName(entry.id));
      expect(entry.label).not.toBe(entry.id);
    }
  });

  it("covers every tool the scenario playbooks can name", () => {
    const ids = new Set(ACTION_REFERENCE_CATALOG.map((e) => e.id));
    for (const tool of [
      "refund.create",
      "discount.create",
      "order.cancel",
      "order.update_shipping_address",
      "supplier.escalate",
      "conversation.ask_customer",
      "knowledge.search",
      "ticket.update_context",
      "shopify.get_order",
      "shopify.get_product",
      "tracking.lookup",
      "merchant.notify",
    ]) {
      expect(ids.has(tool)).toBe(true);
    }
  });
});

describe("resolveFactReferences — action refs (the `/` sigil)", () => {
  it("resolves a `/` action ref to the bare tool id the model calls", () => {
    const { resolved, dangling } = resolveFactReferences(
      "Propose /order.cancel and tell the customer it is done.",
      null,
    );
    expect(resolved).toBe(
      "Propose order.cancel and tell the customer it is done.",
    );
    expect(dangling).toEqual([]);
  });

  it("never flags an action ref as dangling — an action has no tenant value", () => {
    const { dangling } = resolveFactReferences(
      "Use /conversation.ask_customer ONCE, then stop.",
      null,
    );
    expect(dangling).toEqual([]);
  });

  it("leaves an unknown `/` token, a url path, and a date verbatim", () => {
    const text =
      "See https://shop.example/refund.create and /not.atool — we reply 24/7.";
    expect(resolveFactReferences(text, null).resolved).toBe(text);
  });

  it("does not resolve an action id written with the fact sigil", () => {
    // `@refund.create` is a mistake, not an action — the sigils are what tell
    // a Fact from an action, and neither may claim the other's tokens.
    const { resolved } = resolveFactReferences("@refund.create", null);
    expect(resolved).toBe("@refund.create");
  });

  it("resolves facts and actions in the same note", () => {
    const { resolved } = resolveFactReferences(
      "Queue /refund.create, then say it takes @returns.refund_processing_time.",
      withReturns,
    );
    expect(resolved).toBe(
      "Queue refund.create, then say it takes 5–7 business days.",
    );
  });
});

describe("tokenizeActionReferences (the stored-note backfill)", () => {
  it("rewrites a bare tool id into an action ref", () => {
    expect(
      tokenizeActionReferences("Queue refund.create for the damaged line."),
    ).toBe("Queue /refund.create for the damaged line.");
  });

  it("keeps surrounding punctuation intact", () => {
    expect(
      tokenizeActionReferences(
        "Record it with ticket.update_context (productMatch: match); then use refund.create.",
      ),
    ).toBe(
      "Record it with /ticket.update_context (productMatch: match); then use /refund.create.",
    );
  });

  it("is idempotent — a note already carrying refs is untouched", () => {
    const tokenized = tokenizeActionReferences("Use /refund.create.");
    expect(tokenized).toBe("Use /refund.create.");
    expect(tokenizeActionReferences(tokenized)).toBe(tokenized);
  });

  it("leaves fact refs, unknown dotted words, urls, and emails alone", () => {
    const text =
      "Quote @returns.return_window, e.g. see https://shop.example/refund.create or mail a@b.io — not.atool applies.";
    expect(tokenizeActionReferences(text)).toBe(text);
  });

  it("round-trips: tokenize then resolve is the identity on legacy note prose", () => {
    // This is what makes the backfill safe — the agent's prompt is byte-for-byte
    // what it was before the merchant-facing chips existed.
    const legacy =
      "Verify the carrier status first with tracking.lookup, escalate with supplier.escalate, and only then refund.create.";
    const { resolved } = resolveFactReferences(
      tokenizeActionReferences(legacy),
      null,
    );
    expect(resolved).toBe(legacy);
  });
});
