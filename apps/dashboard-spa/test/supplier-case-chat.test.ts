import { describe, expect, it } from "vitest";

import {
  supplierChatMessages,
  supplierEscalationIdFromPathname,
} from "../lib/supplier-case-chat";

const detail = {
  id: "esc-1",
  caseId: "case-1",
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
    expect(supplierEscalationIdFromPathname("/supplier/cases/esc-1")).toBe(
      "esc-1",
    );
  });

  it("is null for the bare list route", () => {
    expect(supplierEscalationIdFromPathname("/supplier/cases")).toBeNull();
    expect(supplierEscalationIdFromPathname("/supplier/cases/")).toBeNull();
  });

  it("is null for non-supplier routes", () => {
    expect(supplierEscalationIdFromPathname("/cases/abc")).toBeNull();
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
