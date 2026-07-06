import { describe, expect, it } from "vitest";

import { approvalDisplayNote } from "../lib/approval-note";

describe("approvalDisplayNote", () => {
  it("uses the ticket context notes as the approval-facing note", () => {
    expect(
      approvalDisplayNote({
        notes: "Customer is worried about the delivery deadline.",
      }),
    ).toBe("Customer is worried about the delivery deadline.");
  });

  it("does not surface blank notes", () => {
    expect(approvalDisplayNote({ notes: "   " })).toBeNull();
    expect(approvalDisplayNote({})).toBeNull();
  });
});
