import { describe, expect, it } from "vitest";
import type {
  CatalogResponse,
  ToolDto,
} from "@support-agent/dashboard-contracts";
import {
  assignableTools,
  isGatedTool,
  toolDisplayLabel,
} from "../lib/catalog.js";

const tool = (over: Partial<ToolDto> & { name: string }): ToolDto => ({
  description: "d",
  risk: "read",
  defaultPermission: "allow",
  sideEffectClass: "none",
  ...over,
});

const catalog: CatalogResponse = {
  agents: [],
  tools: [
    tool({ name: "agent.handoff" }),
    tool({ name: "ticket.update_context" }),
    tool({ name: "ticket.update_status" }),
    tool({ name: "shopify.get_order", risk: "read" }),
    tool({
      name: "conversation.reply",
      risk: "communicate",
      defaultPermission: "ask",
      displayName: "Send customer reply",
    }),
    tool({ name: "refund.create", risk: "money", defaultPermission: "ask" }),
  ],
};

describe("assignableTools", () => {
  it("excludes internal plumbing tools", () => {
    const names = assignableTools(catalog).map((t) => t.name);
    expect(names).not.toContain("agent.handoff");
    expect(names).not.toContain("ticket.update_context");
    expect(names).not.toContain("ticket.update_status");
    expect(names).toContain("shopify.get_order");
    expect(names).toContain("conversation.reply");
    expect(names).toContain("refund.create");
  });
});

describe("isGatedTool", () => {
  it("is true for non-read tools, false for read tools", () => {
    expect(isGatedTool(tool({ name: "x", risk: "read" }))).toBe(false);
    expect(isGatedTool(tool({ name: "x", risk: "communicate" }))).toBe(true);
    expect(isGatedTool(tool({ name: "x", risk: "money" }))).toBe(true);
  });
});

describe("toolDisplayLabel", () => {
  it("prefers displayName, else humanizes the name", () => {
    expect(
      toolDisplayLabel(tool({ name: "conversation.reply", displayName: "Send customer reply" })),
    ).toBe("Send customer reply");
    expect(toolDisplayLabel(tool({ name: "shopify.get_order" }))).toBe("Get order");
  });
});
