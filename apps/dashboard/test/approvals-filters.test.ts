import { describe, expect, it } from "vitest";

import {
  approvalsHiddenParams,
  isDefaultApprovalsFilter,
  multiSelectLabel,
  resolveStatusValues,
  toFilterValues,
} from "../lib/approvals-filters.js";

// The approvals filters became multi-select: each picker (status, risk, tool,
// agent) now contributes a *list* of values. Next.js hands repeated query keys
// to a page as `string[]`, a single key as `string`, and an absent key as
// `undefined` — these helpers normalize all three into a clean list and carry
// the existing "pending is the default landing view" semantics.
describe("approvals multi-select filter helpers", () => {
  describe("toFilterValues", () => {
    it("wraps a lone string into a single-element list", () => {
      expect(toFilterValues("high")).toEqual(["high"]);
    });

    it("passes an array through, dropping empties", () => {
      expect(toFilterValues(["low", "", "high"])).toEqual(["low", "high"]);
    });

    it("treats undefined and empty string as no selection", () => {
      expect(toFilterValues(undefined)).toEqual([]);
      expect(toFilterValues("")).toEqual([]);
    });
  });

  describe("resolveStatusValues", () => {
    it("defaults to pending when the status param is absent", () => {
      expect(resolveStatusValues(undefined)).toEqual(["pending"]);
    });

    it("takes an explicit selection as-is", () => {
      expect(resolveStatusValues(["approved", "rejected"])).toEqual([
        "approved",
        "rejected",
      ]);
    });

    it("normalizes a single status string to a one-element list", () => {
      expect(resolveStatusValues("approved")).toEqual(["approved"]);
    });
  });

  describe("isDefaultApprovalsFilter", () => {
    it("is true for the pending-only landing view", () => {
      expect(
        isDefaultApprovalsFilter({
          status: ["pending"],
          risk: [],
          tool: [],
          agent: [],
        }),
      ).toBe(true);
    });

    it("is false once any picker narrows the list", () => {
      expect(
        isDefaultApprovalsFilter({
          status: ["pending"],
          risk: ["high"],
          tool: [],
          agent: [],
        }),
      ).toBe(false);
      expect(
        isDefaultApprovalsFilter({
          status: ["pending", "approved"],
          risk: [],
          tool: [],
          agent: [],
        }),
      ).toBe(false);
    });
  });

  describe("approvalsHiddenParams", () => {
    it("omits status when it is the pending default", () => {
      expect(
        approvalsHiddenParams({
          status: ["pending"],
          risk: ["high"],
          tool: [],
          agent: [],
        }),
      ).toEqual([["risk", "high"]]);
    });

    it("emits one pair per selected value across pickers", () => {
      expect(
        approvalsHiddenParams({
          status: ["approved", "rejected"],
          risk: ["low", "high"],
          tool: ["refund.create"],
          agent: [],
        }),
      ).toEqual([
        ["status", "approved"],
        ["status", "rejected"],
        ["risk", "low"],
        ["risk", "high"],
        ["tool", "refund.create"],
      ]);
    });
  });

  describe("multiSelectLabel", () => {
    it("shows the empty label when nothing is selected", () => {
      expect(multiSelectLabel([], "Any risk")).toBe("Any risk");
    });

    it("lists one or two selections", () => {
      expect(multiSelectLabel(["Low"], "Any risk")).toBe("Low");
      expect(multiSelectLabel(["Low", "High"], "Any risk")).toBe("Low, High");
    });

    it("collapses three or more into a count", () => {
      expect(multiSelectLabel(["Low", "Medium", "High"], "Any risk")).toBe(
        "3 selected",
      );
    });
  });
});
