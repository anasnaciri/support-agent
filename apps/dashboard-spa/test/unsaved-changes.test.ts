import { describe, expect, it } from "vitest";

import {
  formValuesDirty,
  hasUnsavedChanges,
  setDirtyFlag,
} from "../lib/unsaved-changes";
import {
  NEW_SCENARIO_PREFIX,
  SCENARIO_KEYS_FIELD,
  fieldName,
  resolutionPolicySnapshot,
} from "../lib/parse-resolution";

const formWith = (
  formKeys: ReadonlyArray<string>,
  fields: ReadonlyArray<[string, string]>,
) => {
  const m = new Map<string, string>([
    [SCENARIO_KEYS_FIELD, JSON.stringify(formKeys)],
    ...fields,
  ]);
  return (name: string): string | null => m.get(name) ?? null;
};

describe("dirty flags", () => {
  it("is clean until a source reports a change, and clean again once every source is saved", () => {
    let flags = {};
    expect(hasUnsavedChanges(flags)).toBe(false);

    flags = setDirtyFlag(flags, "scenarios", true);
    expect(hasUnsavedChanges(flags)).toBe(true);

    flags = setDirtyFlag(flags, "facts:shipping", true);
    flags = setDirtyFlag(flags, "scenarios", false);
    expect(hasUnsavedChanges(flags)).toBe(true);

    flags = setDirtyFlag(flags, "facts:shipping", false);
    expect(hasUnsavedChanges(flags)).toBe(false);
  });

  it("keeps the same object when a flag is re-reported unchanged, so React can bail out", () => {
    const flags = setDirtyFlag({}, "scenarios", true);
    expect(setDirtyFlag(flags, "scenarios", true)).toBe(flags);
  });
});

describe("formValuesDirty", () => {
  it("compares a controlled form against the values last saved", () => {
    const saved = { returnWindowDays: "30", refundMethod: "original" };
    expect(formValuesDirty(saved, { ...saved })).toBe(false);
    expect(formValuesDirty(saved, { ...saved, returnWindowDays: "14" })).toBe(
      true,
    );
  });
});

describe("resolutionPolicySnapshot", () => {
  const baseFields: ReadonlyArray<[string, string]> = [
    [fieldName("delivery_issue", "__label"), "Delivery problem"],
    [fieldName("delivery_issue", "__recognition"), "lost / stuck"],
    [fieldName("delivery_issue", "enabled"), "on"],
    [fieldName("delivery_issue", "supplierMode"), "none"],
    [fieldName("delivery_issue", "notes"), "check tracking first"],
  ];

  it("is stable for an untouched form", () => {
    const a = resolutionPolicySnapshot(formWith(["delivery_issue"], baseFields));
    const b = resolutionPolicySnapshot(formWith(["delivery_issue"], baseFields));
    expect(a).toBe(b);
  });

  it("changes when a field is edited, and comes back when the edit is undone", () => {
    const baseline = resolutionPolicySnapshot(
      formWith(["delivery_issue"], baseFields),
    );
    const edited = resolutionPolicySnapshot(
      formWith(
        ["delivery_issue"],
        baseFields.map((f) =>
          f[0] === fieldName("delivery_issue", "notes")
            ? [f[0], "refund straight away"]
            : f,
        ),
      ),
    );
    expect(edited).not.toBe(baseline);

    const undone = resolutionPolicySnapshot(
      formWith(["delivery_issue"], baseFields),
    );
    expect(undone).toBe(baseline);
  });

  it("ignores whitespace-only edits the save would strip anyway", () => {
    const baseline = resolutionPolicySnapshot(
      formWith(["delivery_issue"], baseFields),
    );
    const padded = resolutionPolicySnapshot(
      formWith(
        ["delivery_issue"],
        baseFields.map((f) =>
          f[0] === fieldName("delivery_issue", "notes")
            ? [f[0], "  check tracking first  "]
            : f,
        ),
      ),
    );
    expect(padded).toBe(baseline);
  });

  it("changes when a scenario is toggled off, added, or removed", () => {
    const baseline = resolutionPolicySnapshot(
      formWith(["delivery_issue"], baseFields),
    );

    const toggledOff = resolutionPolicySnapshot(
      formWith(
        ["delivery_issue"],
        baseFields.filter((f) => f[0] !== fieldName("delivery_issue", "enabled")),
      ),
    );
    expect(toggledOff).not.toBe(baseline);

    const added = resolutionPolicySnapshot(
      formWith(["delivery_issue", `${NEW_SCENARIO_PREFIX}0`], baseFields),
    );
    expect(added).not.toBe(baseline);

    const removed = resolutionPolicySnapshot(formWith([], []));
    expect(removed).not.toBe(baseline);
  });
});
