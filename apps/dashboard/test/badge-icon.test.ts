import { describe, expect, it } from "vitest";
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from "lucide-react";

import { badgeIcon } from "../components/ui/badge-icon";

describe("badgeIcon", () => {
  it("maps each semantic variant (incl. its bright cousin) to a status glyph", () => {
    expect(badgeIcon("destructive")).toBe(AlertCircle);
    expect(badgeIcon("destructiveBright")).toBe(AlertCircle);
    expect(badgeIcon("success")).toBe(CheckCircle2);
    expect(badgeIcon("successBright")).toBe(CheckCircle2);
    expect(badgeIcon("warning")).toBe(AlertTriangle);
    expect(badgeIcon("warningBright")).toBe(AlertTriangle);
    expect(badgeIcon("info")).toBe(Info);
    expect(badgeIcon("infoBright")).toBe(Info);
  });

  it("returns null for neutral variants — color/text already carry the meaning", () => {
    expect(badgeIcon("default")).toBeNull();
    expect(badgeIcon("secondary")).toBeNull();
    expect(badgeIcon("outline")).toBeNull();
    expect(badgeIcon("muted")).toBeNull();
  });

  it("returns null for an absent or unknown variant", () => {
    expect(badgeIcon(undefined)).toBeNull();
    expect(badgeIcon(null)).toBeNull();
    expect(badgeIcon("nonsense")).toBeNull();
  });
});
