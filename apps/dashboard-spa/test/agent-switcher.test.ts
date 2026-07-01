import { describe, expect, it } from "vitest";

import {
  agentHref,
  agentSwitcherOptions,
} from "../lib/agent-switcher-data";

describe("agentHref", () => {
  it("points at the agent detail route", () => {
    expect(agentHref("refund-review")).toBe("/settings/agents/refund-review");
  });
});

describe("agentSwitcherOptions", () => {
  const agents = [
    { id: "triage", name: "Triage", mode: "primary" as const },
    { id: "refund-review", name: "Refund review", mode: "subagent" as const },
    { id: "general", name: "General inquiry", mode: "subagent" as const },
  ];

  it("preserves catalog order and builds an href per agent", () => {
    const opts = agentSwitcherOptions(agents, "refund-review");
    expect(opts.map((o) => o.id)).toEqual(["triage", "refund-review", "general"]);
    expect(opts.map((o) => o.href)).toEqual([
      "/settings/agents/triage",
      "/settings/agents/refund-review",
      "/settings/agents/general",
    ]);
  });

  it("flags exactly the current agent", () => {
    const opts = agentSwitcherOptions(agents, "refund-review");
    expect(opts.filter((o) => o.current).map((o) => o.id)).toEqual([
      "refund-review",
    ]);
  });

  it("flags nothing when the current id is unknown", () => {
    const opts = agentSwitcherOptions(agents, "does-not-exist");
    expect(opts.some((o) => o.current)).toBe(false);
  });

  it("carries name and mode through unchanged", () => {
    const [first] = agentSwitcherOptions(agents, "triage");
    expect(first).toEqual({
      id: "triage",
      name: "Triage",
      mode: "primary",
      href: "/settings/agents/triage",
      current: true,
    });
  });
});
