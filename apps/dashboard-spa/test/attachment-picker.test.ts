import { describe, expect, it } from "vitest";
import type { TicketAttachmentSummary } from "@support-agent/dashboard-contracts";
import {
  attachmentPickerState,
  attachmentSourceLabel,
} from "../lib/attachment-picker";

const file = (
  id: string,
  overrides: Partial<TicketAttachmentSummary> = {},
): TicketAttachmentSummary => ({
  id,
  filename: `${id}.png`,
  contentType: "image/png",
  sizeBytes: 1024,
  source: "fulfillment_operator",
  createdAt: "2026-07-09T10:00:00.000Z",
  ...overrides,
});

describe("attachmentSourceLabel", () => {
  it("names each source in merchant-facing words (no schema jargon)", () => {
    expect(attachmentSourceLabel("inbound")).toBe("From the customer");
    expect(attachmentSourceLabel("fulfillment_operator")).toBe("From the fulfillment partner");
    expect(attachmentSourceLabel("merchant")).toBe("Uploaded by your team");
  });
});

describe("attachmentPickerState", () => {
  it("offers every indexed file that isn't already staged", () => {
    const state = attachmentPickerState({
      index: [file("a"), file("b"), file("c")],
      staged: [file("b")],
      max: 8,
    });
    expect(state.available.map((a) => a.id)).toEqual(["a", "c"]);
  });

  it("sorts newest first so the file the fulfillment partner just sent is on top", () => {
    const state = attachmentPickerState({
      index: [
        file("old", { createdAt: "2026-07-01T00:00:00.000Z" }),
        file("new", { createdAt: "2026-07-09T00:00:00.000Z" }),
        file("mid", { createdAt: "2026-07-05T00:00:00.000Z" }),
      ],
      staged: [],
      max: 8,
    });
    expect(state.available.map((a) => a.id)).toEqual(["new", "mid", "old"]);
  });

  it("hides the picker when nothing unstaged is left to offer", () => {
    expect(
      attachmentPickerState({ index: [file("a")], staged: [file("a")], max: 8 })
        .show,
    ).toBe(false);
    expect(
      attachmentPickerState({ index: [], staged: [], max: 8 }).show,
    ).toBe(false);
  });

  it("shows the picker as soon as one indexed file is unstaged", () => {
    expect(
      attachmentPickerState({ index: [file("a")], staged: [], max: 8 }).show,
    ).toBe(true);
  });

  it("reports remaining slots and blocks staging at capacity", () => {
    const state = attachmentPickerState({
      index: [file("a"), file("b")],
      staged: [file("x"), file("y")],
      max: 2,
    });
    expect(state.remainingSlots).toBe(0);
    expect(state.atCapacity).toBe(true);
    // The list still renders (so the manager sees why nothing can be added),
    // but every row is unselectable.
    expect(state.show).toBe(true);
    expect(state.available.map((a) => a.id)).toEqual(["a", "b"]);
  });

  it("counts remaining slots against the staged total, not the index", () => {
    const state = attachmentPickerState({
      index: [file("a"), file("b"), file("c")],
      staged: [file("x")],
      max: 3,
    });
    expect(state.remainingSlots).toBe(2);
    expect(state.atCapacity).toBe(false);
  });
});
