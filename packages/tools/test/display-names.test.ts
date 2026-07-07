import { describe, expect, it } from "vitest";
import { TOOL_DISPLAY_NAMES } from "@support-agent/agent-core";
import { ALL_TOOLS } from "../src/index.js";

// Merchant-facing tool names have ONE source of truth:
// `TOOL_DISPLAY_NAMES` in agent-core. `defineTool` stamps it onto every
// tool, the catalog ships it to the SPA, and the Telegram summarizer falls
// back to it. These tests keep the map and the registry from drifting in
// either direction.

describe("tool display names", () => {
  it("every registered tool has an explicit entry in TOOL_DISPLAY_NAMES", () => {
    for (const tool of ALL_TOOLS) {
      expect(TOOL_DISPLAY_NAMES[tool.name], tool.name).toBeDefined();
    }
  });

  it("every map entry names a registered tool (no stale entries)", () => {
    const registered = new Set(ALL_TOOLS.map((t) => t.name));
    for (const name of Object.keys(TOOL_DISPLAY_NAMES)) {
      expect(registered.has(name), name).toBe(true);
    }
  });

  it("defineTool stamped the map's name onto every tool", () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.displayName).toBe(TOOL_DISPLAY_NAMES[tool.name]);
    }
  });

  it("names are human copy — no ids, dots, or snake_case", () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.displayName).not.toBe(tool.name);
      expect(tool.displayName).not.toMatch(/[._]/u);
      expect(tool.displayName.length).toBeGreaterThan(0);
    }
  });

  it("no two tools share a name (a list of actions must be distinguishable)", () => {
    const names = ALL_TOOLS.map((t) => t.displayName);
    expect(new Set(names).size).toBe(names.length);
  });

  it("pins the renamed labels", () => {
    const byName = new Map(ALL_TOOLS.map((t) => [t.name, t.displayName]));
    expect(byName.get("conversation.reply")).toBe("Reply to the customer");
    expect(byName.get("order.cancel")).toBe("Cancel and refund the order");
    expect(byName.get("supplier.escalate")).toBe("Ask the supplier for help");
    expect(byName.get("supplier.add_sheet_row")).toBe(
      "Log the issue with the supplier",
    );
    expect(byName.get("refund.recommend")).toBe("Recommend a refund");
  });
});
