import { describe, expect, it } from "vitest";

import {
  supplierChatMessages,
  supplierEscalationIdFromPathname,
  trackingEditFeedback,
} from "../lib/supplier-ticket-chat";

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
} as const;

describe("supplierEscalationIdFromPathname", () => {
  it("extracts the escalation id from a detail route", () => {
    expect(supplierEscalationIdFromPathname("/supplier/tickets/esc-1")).toBe(
      "esc-1",
    );
  });

  it("is null for the bare list route", () => {
    expect(supplierEscalationIdFromPathname("/supplier/tickets")).toBeNull();
    expect(supplierEscalationIdFromPathname("/supplier/tickets/")).toBeNull();
  });

  it("is null for non-supplier routes", () => {
    expect(supplierEscalationIdFromPathname("/tickets/abc")).toBeNull();
    expect(supplierEscalationIdFromPathname("/settings/suppliers")).toBeNull();
  });
});

describe("supplierChatMessages", () => {
  it("renders an open escalation as a single inbound message from the support team", () => {
    const messages = supplierChatMessages(detail);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      direction: "inbound",
      sender: "Support team",
      body: detail.problem,
      sentAt: detail.createdAt,
    });
  });

  it("adds the supplier's update as an outbound message once resolved", () => {
    const messages = supplierChatMessages({
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
    const messages = supplierChatMessages({ ...detail, status: "resolved" });
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      direction: "outbound",
      body: "(no note recorded)",
      resolution: null,
    });
  });

  it("keeps inbound-only for open escalations even if a stray note exists", () => {
    const messages = supplierChatMessages({
      ...detail,
      note: "draft note that was never posted",
    });
    expect(messages).toHaveLength(1);
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
      // Every "can't write it to the order" outcome tells the supplier the
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
});
