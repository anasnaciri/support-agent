import { describe, expect, it } from "vitest";

import {
  resyncDraft,
  type ComposerMode,
} from "../app/cases/[id]/composer-draft-sync";

const approval = (approvalId: string, draftBody: string): ComposerMode => ({
  kind: "approval",
  approvalId,
  draftBody,
  returnTo: "/cases/x",
});

// The composer stays mounted across live refreshes (router.refresh keeps the
// client component), so `useState` won't re-init when a draft arrives. These
// pin the reload decision that keeps the editor in sync with the draft.
describe("resyncDraft", () => {
  it("loads the draft when an approval first appears (locked → approval via poll)", () => {
    // Mounted in locked mode (loadedApprovalId = null); a draft now arrives.
    expect(resyncDraft(approval("a1", "Hi there"), null)).toEqual({
      text: "Hi there",
      loadedApprovalId: "a1",
    });
  });

  it("does not clobber edits while the same draft is under review", () => {
    expect(resyncDraft(approval("a1", "edited by hand"), "a1")).toBeNull();
  });

  it("swaps in a new draft when the approval changes", () => {
    expect(resyncDraft(approval("a2", "New draft"), "a1")).toEqual({
      text: "New draft",
      loadedApprovalId: "a2",
    });
  });

  it("clears the editor when the approval goes away (reply / locked)", () => {
    expect(resyncDraft({ kind: "reply" }, "a1")).toEqual({
      text: "",
      loadedApprovalId: null,
    });
    expect(resyncDraft({ kind: "locked", message: "x" }, "a1")).toEqual({
      text: "",
      loadedApprovalId: null,
    });
  });

  it("no-ops for a stable non-approval composer (manual reply edits preserved)", () => {
    expect(resyncDraft({ kind: "reply" }, null)).toBeNull();
    expect(resyncDraft({ kind: "locked", message: "x" }, null)).toBeNull();
  });
});
