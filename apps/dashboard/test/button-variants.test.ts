import { describe, expect, it } from "vitest";
import { twMerge } from "tailwind-merge";

import { buttonVariants } from "../components/ui/button-variants";

// Mirror of `lib/utils`' `cn` without the `@/` alias (unavailable in the vitest
// resolver): the confirm dialog composes classes through the same tailwind-merge.
const cn = (...classes: string[]): string => twMerge(classes.join(" "));

// `AlertDialogAction` (components/ui/alert-dialog.tsx) bakes in the default
// (primary) button styles — `cn(buttonVariants(), className)` — and
// `ConfirmSubmitButton` overlays the caller's variant via
// `className={buttonVariants({ variant })}`. Any variant that doesn't declare
// its OWN base text color lets the primary's white `text-primary-foreground`
// survive the tailwind-merge, landing white text on the light outline/ghost
// background — the "Reject remaining" confirm-dialog contrast bug. Each such
// variant must therefore set an explicit foreground text color.
describe("confirm-dialog action button contrast", () => {
  for (const variant of ["outline", "ghost"] as const) {
    it(`does not leak white primary text onto the ${variant} confirm button`, () => {
      const composed = cn(buttonVariants(), buttonVariants({ variant }));
      expect(composed).not.toContain("text-primary-foreground");
      expect(composed).toContain("text-foreground");
    });
  }
});
