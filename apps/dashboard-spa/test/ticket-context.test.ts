import { describe, expect, it } from "vitest";

import { buildContextCardRows, buildContextRows } from "../lib/ticket-context";

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

  it("merges duplicate-photo flags into one chip carrying the matched ticket ids", () => {
    const row = byKey(
      buildContextRows({
        riskFlags: [
          "duplicate_photo_seen_in_ticket_abc",
          "duplicate_photo_seen_in_ticket_def",
        ],
      }),
      "riskFlags",
    );
    expect(row?.badges).toEqual([
      {
        text: "Duplicate photo seen in 2 tickets",
        variant: "destructive",
        ticketIds: ["abc", "def"],
      },
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

  it("renders the fulfillment partner update's note and proposed resolution as multiline rows", () => {
    const rows = buildContextRows({
      fulfillmentOperatorUpdate: {
        fulfillmentOperatorId: "sup_1",
        note: "Replacement ships Monday\nfrom the EU warehouse",
        proposedResolution: "Send a replacement unit",
      },
    });
    expect(byKey(rows, "fulfillmentOperatorNote")).toMatchObject({
      label: "Fulfillment partner note",
      text: "Replacement ships Monday\nfrom the EU warehouse",
      multiline: true,
    });
    expect(byKey(rows, "fulfillmentOperatorProposedResolution")).toMatchObject({
      label: "Fulfillment partner suggests",
      text: "Send a replacement unit",
      multiline: true,
    });
    // bespoke rows, never the raw-JSON fallback dump
    expect(byKey(rows, "fulfillmentOperatorUpdate")).toBeUndefined();
  });

  it("skips the fulfillment partner proposed-resolution row when the fulfillment partner left it empty", () => {
    const rows = buildContextRows({
      fulfillmentOperatorUpdate: { fulfillmentOperatorId: "sup_1", note: "Out of stock", proposedResolution: null },
    });
    expect(byKey(rows, "fulfillmentOperatorNote")).toMatchObject({ text: "Out of stock" });
    expect(byKey(rows, "fulfillmentOperatorProposedResolution")).toBeUndefined();
  });

  it("renders no fulfillment partner rows for a malformed fulfillmentOperatorUpdate blob", () => {
    const rows = buildContextRows({ fulfillmentOperatorUpdate: { note: "   " } });
    expect(byKey(rows, "fulfillmentOperatorNote")).toBeUndefined();
    expect(byKey(rows, "fulfillmentOperatorUpdate")).toBeUndefined();
  });

  it("renders the runtime-verified order email as its own labeled mono row", () => {
    // Stamped by the runtime once the requester confirms the order's email on a
    // mismatch ticket — a trusted fact, shown distinctly from the (possibly
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

describe("buildContextCardRows", () => {
  // The floating card only shows what the right-hand panels DON'T already
  // cover: the customer's ask, evidence signals, risk flags, and notes.
  const richContext = {
    classification: "refund_request",
    customerEmail: "ada@example.com",
    verifiedCustomerEmail: "ada@example.com",
    identifiedOrderId: "gid://shopify/Order/123",
    identifiedCustomerId: "gid://shopify/Customer/9",
    liveTrackingStatus: { kind: "live", status: "in_transit" },
    scenarioKey: "delivery_issue",
    identityVerified: true,
    pendingOrderEmail: "ada@example.com",
    customerResolutionTriedFor: "email:ada@example.com",
    shopifyCustomerId: "gid://shopify/Customer/9",
    returnReason: "defective",
    requestedResolution: "refund",
    productMatch: "match",
    photoSignals: { count: 2, withExif: 1, stripped: 1, anyStripped: true },
    riskFlags: ["refund_customer_mismatch"],
    notes: "Customer is patient but wants an answer this week.",
    fulfillmentOperatorUpdate: {
      fulfillmentOperatorId: "sup_1",
      note: "Replacement ships Monday",
      proposedResolution: "Send a replacement unit",
    },
  };

  it("keeps only the ask / evidence / risk / notes / fulfillmentOperator rows — no sidebar duplicates or machinery", () => {
    const rows = buildContextCardRows(richContext, null);
    expect(rows.map((r) => r.key)).toEqual([
      "returnReason",
      "requestedResolution",
      "productMatch",
      "photoSignals",
      "riskFlags",
      "notes",
      "fulfillmentOperatorNote",
      "fulfillmentOperatorProposedResolution",
    ]);
  });

  it("returns nothing for a context with only sidebar-covered keys", () => {
    expect(
      buildContextCardRows(
        {
          classification: "where_is_order",
          customerEmail: "ada@example.com",
          identifiedOrderId: "gid://shopify/Order/123",
        },
        { name: "#1042", confirmationNumber: null },
      ),
    ).toEqual([]);
  });

  it("hides the quoted order ref when no order is bound (the Order panel shows it)", () => {
    const rows = buildContextCardRows({ quotedOrderRef: "#1042" }, null);
    expect(rows).toEqual([]);
  });

  it("hides the quoted order ref when it matches the bound order's name (# and case insensitive)", () => {
    for (const quoted of ["#1042", "1042", "#1042 "]) {
      const rows = buildContextCardRows(
        { quotedOrderRef: quoted, identifiedOrderId: "gid://shopify/Order/123" },
        { name: "#1042", confirmationNumber: null },
      );
      expect(rows.find((r) => r.key === "quotedOrderRef")).toBeUndefined();
    }
  });

  it("hides the quoted order ref when it matches the order's confirmation number", () => {
    const rows = buildContextCardRows(
      {
        quotedOrderRef: "xpav284ct",
        identifiedOrderId: "gid://shopify/Order/123",
      },
      { name: "#1042", confirmationNumber: "XPAV284CT" },
    );
    expect(rows.find((r) => r.key === "quotedOrderRef")).toBeUndefined();
  });

  it("keeps the quoted order ref when it differs from the bound order — the mis-quote heads-up", () => {
    const rows = buildContextCardRows(
      {
        quotedOrderRef: "#Q537JR5JA",
        identifiedOrderId: "gid://shopify/Order/123",
        notes: "n",
      },
      { name: "#1042", confirmationNumber: "XPAV284CT" },
    );
    expect(rows.map((r) => r.key)).toEqual(["quotedOrderRef", "notes"]);
  });

  it("keeps the quoted order ref when the bound order could not be fetched (match unprovable)", () => {
    const rows = buildContextCardRows(
      { quotedOrderRef: "#1042", identifiedOrderId: "gid://shopify/Order/123" },
      null,
    );
    expect(rows.map((r) => r.key)).toEqual(["quotedOrderRef"]);
  });

  it("renders the quoted order ref as a skeleton row while the bound order is still loading", () => {
    // On mount the ticket detail resolves before the Shopify order fetch; a
    // pending fetch must NOT be treated like a failed one (the heads-up would
    // appear and then pop out once the order arrives and matches). Instead the
    // slot renders as a skeleton placeholder until the fetch settles.
    const rows = buildContextCardRows(
      {
        quotedOrderRef: "#1042",
        identifiedOrderId: "gid://shopify/Order/123",
        notes: "n",
      },
      "loading",
    );
    expect(rows.map((r) => r.key)).toEqual(["quotedOrderRef", "notes"]);
    expect(byKey(rows, "quotedOrderRef")).toMatchObject({
      label: "Customer-quoted order",
      skeleton: true,
    });
    expect(byKey(rows, "quotedOrderRef")?.text).toBeUndefined();
  });

  it("emits no skeleton row while loading when no heads-up could appear (no quoted ref or no bound order)", () => {
    expect(
      buildContextCardRows({ quotedOrderRef: "#1042", notes: "n" }, "loading").map((r) => r.key),
    ).toEqual(["notes"]);
    expect(
      buildContextCardRows(
        { identifiedOrderId: "gid://shopify/Order/123", notes: "n" },
        "loading",
      ).map((r) => r.key),
    ).toEqual(["notes"]);
  });
});
