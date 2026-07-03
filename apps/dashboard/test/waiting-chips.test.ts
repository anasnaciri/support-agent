import { describe, expect, it } from "vitest";

import { extraWaitChips } from "../lib/waiting-chips.js";

// Concurrent wait states: a case's status is the single primary-wait pointer
// (approval wins), but a case can hold BOTH an open approval and an open
// supplier escalation. extraWaitChips returns the wait facts that hold but are
// NOT already the status badge, so the header/list can render them as a second
// chip without ever duplicating the status badge.
describe("extraWaitChips", () => {
  it("shows the supplier chip when a waiting_for_approval case also waits on a supplier", () => {
    expect(
      extraWaitChips("waiting_for_approval", {
        approval: true,
        supplier: true,
      }),
    ).toEqual(["waiting_for_supplier"]);
  });

  it("never duplicates the status badge as a chip", () => {
    expect(
      extraWaitChips("waiting_for_supplier", {
        approval: false,
        supplier: true,
      }),
    ).toEqual([]);
    expect(
      extraWaitChips("waiting_for_approval", {
        approval: true,
        supplier: false,
      }),
    ).toEqual([]);
  });

  it("emits the approval chip when the primary status is the supplier wait", () => {
    expect(
      extraWaitChips("waiting_for_supplier", {
        approval: true,
        supplier: true,
      }),
    ).toEqual(["waiting_for_approval"]);
  });

  it("returns nothing when waitingOn is absent (older api) or empty", () => {
    expect(extraWaitChips("in_progress", undefined)).toEqual([]);
    expect(
      extraWaitChips("in_progress", { approval: false, supplier: false }),
    ).toEqual([]);
  });
});
