import { describe, expect, it } from "vitest";

import {
  fulfillmentOperatorChatMessages,
  fulfillmentOperatorEscalationIdFromPathname,
  trackingEditFeedback,
} from "../lib/fulfillment-operator-ticket-chat";

const detail = {
  id: "esc-1",
  ticketId: "ticket-1",
  problem: "Package stuck in transit since June 12 — please check with DHL.",
  orderRef: "#1042",
  shipCity: "Lyon",
  shipCountry: "France",
  trackingNumber: "JD014600003",
  status: "open",
  createdAt: "2026-06-28T09:15:00.000Z",
  note: null,
  proposedResolution: null,
  attachments: [],
} as const;

const label = {
  id: "att-1",
  filename: "replacement-label.pdf",
  contentType: "application/pdf",
  sizeBytes: 2048,
} as const;

describe("fulfillmentOperatorEscalationIdFromPathname", () => {
  it("extracts the escalation id from a detail route", () => {
    expect(fulfillmentOperatorEscalationIdFromPathname("/fulfillment-operator/tickets/esc-1")).toBe(
      "esc-1",
    );
  });

  it("is null for the bare list route", () => {
    expect(fulfillmentOperatorEscalationIdFromPathname("/fulfillment-operator/tickets")).toBeNull();
    expect(fulfillmentOperatorEscalationIdFromPathname("/fulfillment-operator/tickets/")).toBeNull();
  });

  it("is null for non-fulfillmentOperator routes", () => {
    expect(fulfillmentOperatorEscalationIdFromPathname("/tickets/abc")).toBeNull();
    expect(fulfillmentOperatorEscalationIdFromPathname("/settings/fulfillment-operators")).toBeNull();
  });
});

describe("fulfillmentOperatorChatMessages", () => {
  it("renders an open escalation as a single inbound message from the support team", () => {
    const messages = fulfillmentOperatorChatMessages(detail);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      direction: "inbound",
      sender: "Support team",
      body: detail.problem,
      sentAt: detail.createdAt,
    });
  });

  it("adds the fulfillment partner's update as an outbound message once resolved", () => {
    const messages = fulfillmentOperatorChatMessages({
      ...detail,
      status: "resolved",
      note: "Reshipped via DHL, new ETA Friday.",
      proposedResolution: "reship",
    });
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      direction: "outbound",
      sender: "You",
      body: "Reshipped via DHL, new ETA Friday.",
      resolution: "reship",
    });
  });

  it("falls back to a placeholder body when a resolved escalation has no note", () => {
    const messages = fulfillmentOperatorChatMessages({ ...detail, status: "resolved" });
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      direction: "outbound",
      body: "(no note recorded)",
      resolution: null,
    });
  });

  it("keeps inbound-only for open escalations even if a stray note exists", () => {
    const messages = fulfillmentOperatorChatMessages({
      ...detail,
      note: "draft note that was never posted",
    });
    expect(messages).toHaveLength(1);
  });

  it("carries the files the fulfillment partner sent on their own outbound message", () => {
    const messages = fulfillmentOperatorChatMessages({
      ...detail,
      status: "resolved",
      note: "Label attached.",
      attachments: [label],
    });
    expect(messages[1]?.attachments).toEqual([label]);
    // The support team's request never claims the fulfillment partner's files.
    expect(messages[0]?.attachments).toEqual([]);
  });

  it("shows no files on a resolved escalation the fulfillment partner sent none for", () => {
    const messages = fulfillmentOperatorChatMessages({ ...detail, status: "resolved" });
    expect(messages[1]?.attachments).toEqual([]);
  });

  it("never shows uploaded files while the escalation is still open", () => {
    // Files staged by an upload but never submitted (abandoned draft) must not
    // surface as though the fulfillment partner had already answered.
    const messages = fulfillmentOperatorChatMessages({ ...detail, attachments: [label] });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.attachments).toEqual([]);
  });
});

describe("trackingEditFeedback", () => {
  it("success on 200", () => {
    const fb = trackingEditFeedback(200, { ok: true });
    expect(fb.kind).toBe("success");
    expect(fb.message).toMatch(/tracking number/i);
  });

  it("explains an already-answered ticket", () => {
    const fb = trackingEditFeedback(409, { error: "already_resolved" });
    expect(fb.kind).toBe("error");
    expect(fb.message).toMatch(/already responded/i);
  });

  it("points at the update note when the order or shipment can't be targeted", () => {
    for (const kind of [
      "order_not_found",
      "no_fulfillment",
      "ambiguous_fulfillment",
    ]) {
      const fb = trackingEditFeedback(409, { kind });
      expect(fb.kind).toBe("error");
      // Every "can't write it to the order" outcome tells the fulfillment partner the
      // number still reaches the team via their written update.
      expect(fb.message).toMatch(/update/i);
    }
  });

  it("distinct messages for no-shipment vs several-shipments", () => {
    const none = trackingEditFeedback(409, { kind: "no_fulfillment" });
    const many = trackingEditFeedback(409, { kind: "ambiguous_fulfillment" });
    expect(none.message).not.toBe(many.message);
  });

  it("generic retryable failure on 502 and unknown statuses, without leaking detail", () => {
    const fb = trackingEditFeedback(502, {
      kind: "update_failed",
      error: "tracking update rejected: ShopifyAuthFailed for tenant t1",
    });
    expect(fb.kind).toBe("error");
    expect(fb.message).not.toContain("ShopifyAuthFailed");
    expect(trackingEditFeedback(500, null).kind).toBe("error");
  });

  it("explains a store permission issue without asking the fulfillment partner to retry", () => {
    const fb = trackingEditFeedback(502, {
      kind: "shopify_permission_required",
      requiredScopes: [
        "write_merchant_managed_fulfillment_orders",
        "write_third_party_fulfillment_orders",
      ],
      requiredPermission: "fulfill_and_ship_orders",
    });
    expect(fb.kind).toBe("error");
    expect(fb.message).toMatch(/store connection/i);
    expect(fb.message).toMatch(/update below/i);
    expect(fb.message).not.toMatch(/try again/i);
  });
});
