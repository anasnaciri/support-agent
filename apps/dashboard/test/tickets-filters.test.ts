import { describe, expect, it } from "vitest";

import {
  ticketsHiddenParams,
  isDefaultTicketsFilter,
} from "../lib/tickets-filters.js";

// The tickets-list status filter is a multi-select over `<form method="get">`.
// Unlike approvals (which defaults to pending), tickets default to *no* filter —
// the list shows every status until the merchant narrows it. These helpers
// carry the active selection through pagination and decide when "Reset" shows.

describe("isDefaultTicketsFilter", () => {
  it("is the default when nothing is selected", () => {
    expect(isDefaultTicketsFilter([])).toBe(true);
  });

  it("is not the default once any status is picked", () => {
    expect(isDefaultTicketsFilter(["resolved"])).toBe(false);
    expect(isDefaultTicketsFilter(["resolved", "in_progress"])).toBe(false);
  });
});

describe("ticketsHiddenParams", () => {
  it("carries no pairs when no status is selected", () => {
    expect(ticketsHiddenParams([])).toEqual([]);
  });

  it("emits one [status, value] pair per selected status", () => {
    expect(ticketsHiddenParams(["resolved", "in_progress"])).toEqual([
      ["status", "resolved"],
      ["status", "in_progress"],
    ]);
  });
});
