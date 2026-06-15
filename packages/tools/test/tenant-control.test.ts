import { describe, expect, it } from "vitest";
import type { AnyTool, TenantToolControl } from "@support-agent/agent-core";
import {
  ALL_TOOLS,
  conversationReply,
  conversationAskCustomer,
  supplierAddSheetRow,
  supplierEscalate,
  shopifyRefundCreate,
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
      displayName: "Send customer reply",
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
      displayName: "Escalate to supplier",
      control: "permission-toggle",
    },
    {
      tool: supplierEscalate,
      name: "supplier.escalate",
      displayName: "Escalate to supplier",
      control: "permission-toggle",
    },
    {
      tool: shopifyRefundCreate,
      name: "refund.create",
      displayName: "Issue a refund",
      control: "refund-threshold",
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
      ].sort(),
    );
  });

  it("internal tools carry no display label", () => {
    for (const t of ALL_TOOLS) {
      if (t.tenantControl === undefined) {
        expect(t.displayName).toBeUndefined();
      }
    }
  });
});
