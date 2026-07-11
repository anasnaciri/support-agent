import { describe, expect, it } from "vitest";

import {
  DIALOG_CONTENT_MOTION,
  DIALOG_OVERLAY_MOTION,
} from "../components/ui/dialog-motion";

describe("dialog motion", () => {
  it("never slides the content in from the left or the top", () => {
    // The old shadcn/Tailwind-v3 pairing (a half-width left slide plus a 48%
    // top slide) re-applied the centring translate inside the keyframe. Under
    // Tailwind v4 the centring lives on `translate`, so those classes only
    // dragged the dialog in diagonally from the top-left.
    expect(DIALOG_CONTENT_MOTION).not.toMatch(/slide-(in-from|out-to)-left/);
    expect(DIALOG_CONTENT_MOTION).not.toMatch(/slide-(in-from|out-to)-top/);
  });

  it("fades and scales from the centre on entry and on exit", () => {
    for (const cls of [
      "data-[state=open]:animate-in",
      "data-[state=open]:fade-in-0",
      "data-[state=open]:zoom-in-95",
      "data-[state=closed]:animate-out",
      "data-[state=closed]:fade-out-0",
      "data-[state=closed]:zoom-out-95",
    ]) {
      expect(DIALOG_CONTENT_MOTION).toContain(cls);
    }
  });

  it("rises from the bottom on phones and drops back down on exit", () => {
    expect(DIALOG_CONTENT_MOTION).toContain(
      "data-[state=open]:slide-in-from-bottom-6",
    );
    expect(DIALOG_CONTENT_MOTION).toContain(
      "data-[state=closed]:slide-out-to-bottom-6",
    );
    // …and no vertical travel once there's room for a centred dialog.
    expect(DIALOG_CONTENT_MOTION).toContain(
      "sm:data-[state=open]:slide-in-from-bottom-0",
    );
    expect(DIALOG_CONTENT_MOTION).toContain(
      "sm:data-[state=closed]:slide-out-to-bottom-0",
    );
  });

  it("cross-fades the overlay both ways", () => {
    expect(DIALOG_OVERLAY_MOTION).toContain("data-[state=open]:fade-in-0");
    expect(DIALOG_OVERLAY_MOTION).toContain("data-[state=closed]:fade-out-0");
    expect(DIALOG_OVERLAY_MOTION).toContain("data-[state=closed]:animate-out");
  });
});
