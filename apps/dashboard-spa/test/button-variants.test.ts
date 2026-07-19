import { describe, expect, it } from "vitest";

import { buttonVariants } from "@/components/ui/button";

// Buttons opt out of the dark pastel ramp via the scoped *-solid tokens:
// --primary/--destructive stay text-legible (light blue / soft red with ink
// foregrounds) for links, badges, and status text, while solid button fills
// use --primary-solid/--destructive-solid — saturated brand colors with
// white text in dark mode. Buttons must never sit on the bare tokens.
describe("buttonVariants solid chrome", () => {
  it("default buttons use the solid primary tokens, not bare --primary", () => {
    const cls = buttonVariants({ variant: "default" });
    expect(cls).toContain("bg-primary-solid");
    expect(cls).toContain("text-primary-solid-foreground");
    expect(cls).not.toMatch(/bg-primary(?!-solid)/);
  });

  it("destructive buttons use the solid fill tokens, not bare --destructive", () => {
    const cls = buttonVariants({ variant: "destructive" });
    expect(cls).toContain("bg-destructive-solid");
    expect(cls).toContain("text-destructive-solid-foreground");
    expect(cls).not.toMatch(/bg-destructive(?!-solid)/);
  });
});
