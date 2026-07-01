import { describe, expect, it } from "vitest";

import { buildContextRows } from "../lib/case-context";

const byKey = (rows: ReturnType<typeof buildContextRows>, key: string) =>
  rows.find((r) => r.key === key);

describe("buildContextRows", () => {
  it("returns nothing for an empty / absent context", () => {
    expect(buildContextRows({})).toEqual([]);
    expect(buildContextRows({ notes: "   " })).toEqual([]); // blank string skipped
  });

  it("humanizes the classification into a Category row", () => {
    const row = byKey(buildContextRows({ classification: "where_is_order" }), "classification");
    expect(row).toMatchObject({ label: "Category", text: "Where is order" });
    expect(row?.badges).toBeUndefined();
  });

  it("renders ids and email as monospace text rows", () => {
    const rows = buildContextRows({
      customerEmail: "ada@example.com",
      identifiedOrderId: "gid://shopify/Order/123",
      identifiedCustomerId: "gid://shopify/Customer/9",
    });
    expect(byKey(rows, "customerEmail")).toMatchObject({
      label: "Customer email",
      text: "ada@example.com",
      mono: true,
    });
    expect(byKey(rows, "identifiedOrderId")).toMatchObject({ mono: true });
    expect(byKey(rows, "identifiedCustomerId")).toMatchObject({ mono: true });
  });

  it("renders the customer-quoted order reference as its own labeled row", () => {
    // The untrusted hint, shown distinctly from the canonical resolved Order so
    // an operator can see what the customer said vs. what the system resolved.
    const row = byKey(
      buildContextRows({ quotedOrderRef: "Q537JR5JA" }),
      "quotedOrderRef",
    );
    expect(row).toMatchObject({
      label: "Customer-quoted order",
      text: "Q537JR5JA",
      mono: true,
    });
  });

  it("maps the closed enums to friendly badges", () => {
    const rows = buildContextRows({
      returnReason: "wrong_item",
      requestedResolution: "store_credit",
      productMatch: "mismatch",
    });
    expect(byKey(rows, "returnReason")?.badges).toEqual([
      { text: "Wrong item", variant: "secondary" },
    ]);
    expect(byKey(rows, "requestedResolution")?.badges).toEqual([
      { text: "Store credit", variant: "secondary" },
    ]);
    const pm = byKey(rows, "productMatch")?.badges?.[0];
    expect(pm?.variant).toBe("destructive");
  });

  it("ignores enum values outside the closed vocabulary", () => {
    const rows = buildContextRows({
      returnReason: "made_up",
      productMatch: "ok",
    });
    expect(byKey(rows, "returnReason")).toBeUndefined();
    expect(byKey(rows, "productMatch")).toBeUndefined();
  });

  it("renders each risk flag as its own destructive badge via riskFlagLabel", () => {
    const row = byKey(
      buildContextRows({ riskFlags: ["refund_customer_mismatch", "high_value", 7] }),
      "riskFlags",
    );
    expect(row?.label).toBe("Risk flags");
    expect(row?.badges).toEqual([
      // delegated to the shared riskFlagLabel — friendlier than a raw humanize
      { text: "Refund order belongs to a different customer", variant: "destructive" },
      { text: "High value", variant: "destructive" },
    ]);
  });

  it("summarizes photo signals as a readable sentence", () => {
    const row = byKey(
      buildContextRows({
        photoSignals: { count: 3, withExif: 1, stripped: 2, anyStripped: true },
      }),
      "photoSignals",
    );
    expect(row?.text).toBe("3 photos · 1 with location data · 2 had metadata removed");
  });

  it("does not render liveTrackingStatus as a context row (the Tracking card owns it)", () => {
    const rows = buildContextRows({
      liveTrackingStatus: { kind: "live", status: "in_transit", carrier: "UPS" },
    });
    expect(rows.find((r) => r.key === "liveTrackingStatus")).toBeUndefined();
  });

  it("renders notes as a multiline text row", () => {
    const row = byKey(buildContextRows({ notes: "Customer is a VIP\nbe gentle" }), "notes");
    expect(row).toMatchObject({ label: "Notes", multiline: true });
  });

  it("renders the runtime-verified order email as its own labeled mono row", () => {
    // Stamped by the runtime once the requester confirms the order's email on a
    // mismatch case — a trusted fact, shown distinctly from the (possibly
    // mistyped) corresponding `customerEmail`, not buried as a fallback row.
    const row = byKey(
      buildContextRows({ verifiedCustomerEmail: "victim@example.com" }),
      "verifiedCustomerEmail",
    );
    expect(row).toMatchObject({
      label: "Verified order email",
      text: "victim@example.com",
      mono: true,
    });
  });

  it("never hides an unknown key — humanizes it as a fallback row", () => {
    const rows = buildContextRows({ someFutureField: "hello", emptyObj: {} });
    expect(byKey(rows, "someFutureField")).toMatchObject({
      label: "Some future field",
      text: "hello",
    });
    // an empty object carries no information — skip it rather than show "{}"
    expect(byKey(rows, "emptyObj")).toBeUndefined();
  });

  it("orders known rows ahead of unknown ones", () => {
    const rows = buildContextRows({
      zzz_custom: "x",
      classification: "returns",
      customerEmail: "a@b.com",
    });
    expect(rows.map((r) => r.key)).toEqual([
      "classification",
      "customerEmail",
      "zzz_custom",
    ]);
  });
});
