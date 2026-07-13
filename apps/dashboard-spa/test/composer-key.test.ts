import { describe, expect, it } from "vitest";
import { composerKey } from "../lib/composer-key";
import type { ComposerMode } from "../features/tickets/ChatComposer";

// Typed as the component's ComposerMode so this test also proves the
// structural compatibility composerKey relies on.
const locked: ComposerMode = { kind: "locked", message: "agent working" };

const approval = (
  approvalId: string,
  draftBody: string,
): ComposerMode => ({
  kind: "approval",
  approvalId,
  draftBody,
  proposedInput: { bodyText: draftBody },
});

describe("composerKey", () => {
  it("keeps the key stable across locked → reply so takeover doesn't remount", () => {
    expect(composerKey("t1", locked)).toBe(composerKey("t1", { kind: "reply" }));
  });

  it("changes the key when a live refresh flips locked → approval, so the draft seeds the input", () => {
    expect(composerKey("t1", locked)).not.toBe(
      composerKey("t1", approval("a1", "Hi, your order shipped.")),
    );
  });

  it("keeps the key stable across refetches of the same pending approval (manager edits survive)", () => {
    expect(composerKey("t1", approval("a1", "Hi there"))).toBe(
      composerKey("t1", approval("a1", "Hi there")),
    );
  });

  it("changes the key for a different approval on the same ticket", () => {
    expect(composerKey("t1", approval("a1", "Hi"))).not.toBe(
      composerKey("t1", approval("a2", "Hi")),
    );
  });

  it("changes the key when the same approval is redrafted with a new body", () => {
    expect(composerKey("t1", approval("a1", "old draft"))).not.toBe(
      composerKey("t1", approval("a1", "new draft after fulfillment partner update")),
    );
  });

  it("changes the key across tickets", () => {
    expect(composerKey("t1", { kind: "reply" })).not.toBe(
      composerKey("t2", { kind: "reply" }),
    );
  });
});
