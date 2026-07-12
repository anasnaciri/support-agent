import { describe, expect, it } from "vitest";
import type { AnyTool, TenantToolControl } from "@support-agent/agent-core";
import {
  ALL_TOOLS,
  conversationReply,
  conversationAskCustomer,
  supplierAddSheetRow,
  supplierEscalate,
  shopifyRefundCreate,
  shopifyDiscountCreate,
  shopifyOrderCancel,
  shopifyUpdateShippingAddress,
  shopifyUpdateTracking,
} from "../src/index.js";

// The dashboard's tenant-facing "Actions" card is driven entirely by this
// metadata — `tenantControl` decides what a merchant sees, `displayName` is the
// friendly label. These tests pin the curated set so internal plumbing can
// never leak onto the tenant page by accident.

describe("tenant-facing tool metadata", () => {
  const expected: ReadonlyArray<{
    readonly tool: AnyTool;
    readonly name: string;
    readonly displayName: string;
    readonly control: TenantToolControl;
  }> = [
    {
      tool: conversationReply,
      name: "conversation.reply",
      displayName: "Reply to the customer",
      control: "permission-toggle",
    },
    {
      tool: conversationAskCustomer,
      name: "conversation.ask_customer",
      displayName: "Ask the customer a question",
      control: "permission-toggle",
    },
    {
      tool: supplierAddSheetRow,
      name: "supplier.add_sheet_row",
      displayName: "Log the issue with the supplier",
      control: "permission-toggle",
    },
    {
      tool: supplierEscalate,
      name: "supplier.escalate",
      displayName: "Ask the supplier for help",
      control: "permission-toggle",
    },
    {
      tool: shopifyRefundCreate,
      name: "refund.create",
      displayName: "Issue a refund",
      control: "refund-threshold",
    },
    {
      tool: shopifyDiscountCreate,
      name: "discount.create",
      displayName: "Issue a discount code",
      control: "discount-threshold",
    },
    {
      tool: shopifyOrderCancel,
      name: "order.cancel",
      displayName: "Cancel and refund the order",
      // Cancelling issues a refund, so it's governed by the refund policy —
      // same control as refund.create.
      control: "refund-threshold",
    },
    {
      tool: shopifyUpdateShippingAddress,
      name: "order.update_shipping_address",
      displayName: "Update the shipping address",
      control: "permission-toggle",
    },
    {
      tool: shopifyUpdateTracking,
      name: "order.update_tracking",
      displayName: "Update the tracking number",
      control: "permission-toggle",
    },
  ];

  for (const e of expected) {
    it(`${e.name} is tenant-facing with a friendly name + ${e.control}`, () => {
      expect(e.tool.name).toBe(e.name);
      expect(e.tool.displayName).toBe(e.displayName);
      expect(e.tool.tenantControl).toBe(e.control);
      expect(e.tool.displayDescription).toBeTruthy();
    });
  }

  it("exposes exactly the curated actions — everything else stays internal", () => {
    const configurable = ALL_TOOLS.filter((t) => t.tenantControl !== undefined)
      .map((t) => t.name)
      .sort();
    expect(configurable).toEqual(
      [
        "conversation.reply",
        "conversation.ask_customer",
        "supplier.add_sheet_row",
        "supplier.escalate",
        "refund.create",
        "discount.create",
        "order.cancel",
        "order.update_shipping_address",
        "order.update_tracking",
      ].sort(),
    );
  });

  it("internal tools stay off the tenant page (no tenantControl), but still carry a friendly name", () => {
    for (const t of ALL_TOOLS) {
      if (t.tenantControl === undefined) {
        // Visibility is governed by tenantControl alone; the name exists for
        // audit rows / timelines, where an id must never surface.
        expect(t.displayName).toBeTruthy();
        expect(t.displayName).not.toBe(t.name);
      }
    }
  });
});
