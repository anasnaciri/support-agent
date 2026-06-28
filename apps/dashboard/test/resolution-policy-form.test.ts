import { describe, expect, it } from "vitest";
import type { ResolutionScenarioView } from "@support-agent/dashboard-contracts";

import {
  fieldName,
  parseResolutionForm,
} from "../app/settings/resolution-policy/parse-resolution";

const stored: ReadonlyArray<ResolutionScenarioView> = [
  {
    key: "delivery_issue",
    label: "Delivery problem",
    recognition: "lost / stuck",
    builtin: true,
    enabled: true,
    enabledActions: [{ tool: "refund.create", permission: "ask" }],
    supplierMode: "escalate_and_wait",
    notes: "check tracking",
  },
  {
    key: "general_inquiry",
    label: "General question",
    recognition: null,
    builtin: true,
    enabled: true,
    enabledActions: [],
    supplierMode: "none",
    notes: null,
  },
];

const getter =
  (m: Map<string, string>) =>
  (name: string): string | null =>
    m.get(name) ?? null;

describe("parseResolutionForm", () => {
  it("keeps immutable fields and applies enabled actions, permissions, supplier mode, notes", () => {
    const m = new Map<string, string>([
      [fieldName("delivery_issue", "enabled"), "on"],
      [fieldName("delivery_issue", "action:refund.create:enabled"), "on"],
      [fieldName("delivery_issue", "action:refund.create:permission"), "allow"],
      [fieldName("delivery_issue", "action:discount.create:enabled"), "on"],
      [fieldName("delivery_issue", "action:discount.create:permission"), "ask"],
      [fieldName("delivery_issue", "supplierMode"), "notify_and_proceed"],
      [fieldName("delivery_issue", "notes"), "  ship fast  "],
      [fieldName("general_inquiry", "supplierMode"), "none"],
    ]);

    const out = parseResolutionForm(getter(m), stored);

    const d = out[0]!;
    // delivery_issue had its Active box checked; general_inquiry did not.
    expect(d.enabled).toBe(true);
    expect(out[1]!.enabled).toBe(false);
    expect(d.key).toBe("delivery_issue");
    expect(d.label).toBe("Delivery problem");
    expect(d.recognition).toBe("lost / stuck");
    expect(d.builtin).toBe(true);
    expect(new Set(d.enabledActions.map((a) => a.tool))).toEqual(
      new Set(["refund.create", "discount.create"]),
    );
    expect(
      d.enabledActions.find((a) => a.tool === "refund.create")?.permission,
    ).toBe("allow");
    expect(
      d.enabledActions.find((a) => a.tool === "discount.create")?.permission,
    ).toBe("ask");
    expect(d.supplierMode).toBe("notify_and_proceed");
    expect(d.notes).toBe("ship fast"); // trimmed

    const g = out[1]!;
    expect(g.enabledActions).toEqual([]);
    expect(g.supplierMode).toBe("none");
    expect(g.notes).toBeNull();
  });

  it("drops an action whose checkbox is not checked, even if a permission is present", () => {
    const m = new Map<string, string>([
      [fieldName("delivery_issue", "action:refund.create:permission"), "allow"],
    ]);
    const out = parseResolutionForm(getter(m), stored);
    expect(out[0]!.enabledActions).toEqual([]);
  });

  it("falls back to the stored supplier mode when the form value is missing/invalid", () => {
    const out = parseResolutionForm(getter(new Map()), stored);
    expect(out[0]!.supplierMode).toBe("escalate_and_wait");
    const bad = new Map([[fieldName("delivery_issue", "supplierMode"), "nope"]]);
    expect(parseResolutionForm(getter(bad), stored)[0]!.supplierMode).toBe(
      "escalate_and_wait",
    );
  });

  it("defaults an enabled action's permission to ask when not 'allow'", () => {
    const m = new Map<string, string>([
      [fieldName("general_inquiry", "action:refund.create:enabled"), "on"],
    ]);
    const out = parseResolutionForm(getter(m), stored);
    expect(out[1]!.enabledActions).toEqual([
      { tool: "refund.create", permission: "ask" },
    ]);
  });
});
