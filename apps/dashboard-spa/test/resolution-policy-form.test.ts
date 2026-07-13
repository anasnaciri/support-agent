import { describe, expect, it } from "vitest";
import { toolDisplayName } from "@support-agent/agent-core";

import {
  NEW_SCENARIO_PREFIX,
  SCENARIO_KEYS_FIELD,
  fieldName,
  parseResolutionForm,
} from "../lib/parse-resolution";
import {
  REMEDY_ACTIONS,
  deniedActionsFor,
} from "../lib/resolution-action-labels";

const getter =
  (m: Map<string, string>) =>
  (name: string): string | null =>
    m.get(name) ?? null;

// Build a getter from a manifest (the hidden field listing every card's form
// key) plus the per-field values.
const formWith = (formKeys: ReadonlyArray<string>, fields: [string, string][]) =>
  getter(
    new Map<string, string>([
      [SCENARIO_KEYS_FIELD, JSON.stringify(formKeys)],
      ...fields,
    ]),
  );

describe("REMEDY_ACTIONS", () => {
  it("names each action exactly as the rest of the app does", () => {
    // The checkbox, the playbook chip, and the ticket timeline must all call an
    // action the same thing — TOOL_DISPLAY_NAMES is that one name.
    for (const action of REMEDY_ACTIONS) {
      expect(action.label).toBe(toolDisplayName(action.tool));
    }
  });
});

describe("deniedActionsFor", () => {
  it("denies every remedy action the scenario didn't enable", () => {
    const denied = deniedActionsFor(new Set(["refund.create"]), "none");
    expect(denied.has("refund.create")).toBe(false);
    expect(denied.has("discount.create")).toBe(true);
    expect(denied.has("order.cancel")).toBe(true);
  });

  it("denies the fulfillment partner escalation only when no fulfillment partner is involved", () => {
    expect(deniedActionsFor(new Set(), "none").has("fulfillment_operator.escalate")).toBe(
      true,
    );
    expect(
      deniedActionsFor(new Set(), "escalate_and_wait").has("fulfillment_operator.escalate"),
    ).toBe(false);
    expect(
      deniedActionsFor(new Set(), "notify_and_proceed").has("fulfillment_operator.escalate"),
    ).toBe(false);
  });

  it("never denies a baseline action — those are always on", () => {
    const denied = deniedActionsFor(new Set(), "none");
    expect(denied.has("knowledge.search")).toBe(false);
    expect(denied.has("conversation.ask_customer")).toBe(false);
    expect(denied.has("shopify.get_order")).toBe(false);
  });
});

describe("parseResolutionForm", () => {
  it("parses a built-in card: editable fields from the form, key/label/recognition passed through", () => {
    const get = formWith(
      ["delivery_issue"],
      [
        [fieldName("delivery_issue", "__label"), "Delivery problem"],
        [fieldName("delivery_issue", "__recognition"), "lost / stuck"],
        [fieldName("delivery_issue", "enabled"), "on"],
        [fieldName("delivery_issue", "action:refund.create:enabled"), "on"],
        [fieldName("delivery_issue", "action:refund.create:permission"), "allow"],
        [fieldName("delivery_issue", "fulfillmentOperatorMode"), "notify_and_proceed"],
        [fieldName("delivery_issue", "notes"), "  ship fast  "],
      ],
    );
    const out = parseResolutionForm(get);
    expect(out).toHaveLength(1);
    const d = out[0]!;
    expect(d.key).toBe("delivery_issue");
    expect(d.builtin).toBe(true);
    expect(d.label).toBe("Delivery problem");
    expect(d.recognition).toBe("lost / stuck");
    expect(d.enabled).toBe(true);
    expect(d.enabledActions).toEqual([
      { tool: "refund.create", permission: "allow" },
    ]);
    expect(d.fulfillmentOperatorMode).toBe("notify_and_proceed");
    expect(d.notes).toBe("ship fast");
  });

  it("treats an existing custom_ card as custom and keeps its key + editable label/recognition", () => {
    const get = formWith(
      ["custom_vip"],
      [
        [fieldName("custom_vip", "label"), "  VIP complaint  "],
        [fieldName("custom_vip", "recognition"), "  angry whale  "],
        [fieldName("custom_vip", "enabled"), "on"],
        [fieldName("custom_vip", "fulfillmentOperatorMode"), "none"],
      ],
    );
    const c = parseResolutionForm(get)[0]!;
    expect(c.builtin).toBe(false);
    expect(c.key).toBe("custom_vip");
    expect(c.label).toBe("VIP complaint");
    expect(c.recognition).toBe("angry whale");
  });

  it("strips a freshly-added __new_ card's key to '' so the server assigns one", () => {
    const get = formWith(
      [`${NEW_SCENARIO_PREFIX}0`],
      [
        [fieldName(`${NEW_SCENARIO_PREFIX}0`, "label"), "Wholesale"],
        [fieldName(`${NEW_SCENARIO_PREFIX}0`, "recognition"), "bulk buyer"],
        [fieldName(`${NEW_SCENARIO_PREFIX}0`, "enabled"), "on"],
      ],
    );
    const c = parseResolutionForm(get)[0]!;
    expect(c.key).toBe("");
    expect(c.builtin).toBe(false);
    expect(c.label).toBe("Wholesale");
    expect(c.recognition).toBe("bulk buyer");
  });

  it("drops an action whose checkbox is unchecked even if a permission is present", () => {
    const get = formWith(
      ["delivery_issue"],
      [
        [fieldName("delivery_issue", "action:refund.create:permission"), "allow"],
      ],
    );
    expect(parseResolutionForm(get)[0]!.enabledActions).toEqual([]);
  });

  it("defaults an enabled action's permission to ask when not 'allow'", () => {
    const get = formWith(
      ["general_inquiry"],
      [[fieldName("general_inquiry", "action:refund.create:enabled"), "on"]],
    );
    expect(parseResolutionForm(get)[0]!.enabledActions).toEqual([
      { tool: "refund.create", permission: "ask" },
    ]);
  });

  it("defaults a missing/invalid fulfillmentOperator mode to none and an unchecked Active to false", () => {
    const get = formWith(["general_inquiry"], [
      [fieldName("general_inquiry", "fulfillmentOperatorMode"), "nope"],
    ]);
    const g = parseResolutionForm(get)[0]!;
    expect(g.fulfillmentOperatorMode).toBe("none");
    expect(g.enabled).toBe(false);
    expect(g.notes).toBeNull();
  });

  it("returns [] when the manifest is missing or malformed", () => {
    expect(parseResolutionForm(getter(new Map()))).toEqual([]);
    expect(
      parseResolutionForm(getter(new Map([[SCENARIO_KEYS_FIELD, "{not json"]]))),
    ).toEqual([]);
  });
});
