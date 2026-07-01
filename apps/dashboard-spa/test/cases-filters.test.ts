import { describe, expect, it } from "vitest";

import {
  casesHiddenParams,
  isDefaultCasesFilter,
} from "../lib/cases-filters.js";

// The cases-list status filter is a multi-select over `<form method="get">`.
// Unlike approvals (which defaults to pending), cases default to *no* filter —
// the list shows every status until the merchant narrows it. These helpers
// carry the active selection through pagination and decide when "Reset" shows.

describe("isDefaultCasesFilter", () => {
  it("is the default when nothing is selected", () => {
    expect(isDefaultCasesFilter([])).toBe(true);
  });

  it("is not the default once any status is picked", () => {
    expect(isDefaultCasesFilter(["resolved"])).toBe(false);
    expect(isDefaultCasesFilter(["resolved", "in_progress"])).toBe(false);
  });
});

describe("casesHiddenParams", () => {
  it("carries no pairs when no status is selected", () => {
    expect(casesHiddenParams([])).toEqual([]);
  });

  it("emits one [status, value] pair per selected status", () => {
    expect(casesHiddenParams(["resolved", "in_progress"])).toEqual([
      ["status", "resolved"],
      ["status", "in_progress"],
    ]);
  });
});
