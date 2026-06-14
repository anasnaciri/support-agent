import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";
import { badgeIcon } from "./badge-icon";

const badgeVariants = cva(
  // A leading status icon (when the variant has one) is sized relative to the
  // label via `[&>svg]:size-[1.15em]` so it scales with the badge — no flex
  // `gap` (badges interpolate multi-node text like "Risk: high", which a gap
  // would space apart); the icon's own `me-1` provides the separation.
  "inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 [&>svg]:me-1 [&>svg]:size-[1.15em] [&>svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary:
          "border-border bg-secondary text-secondary-foreground dark:border-transparent",
        destructive:
          "border-destructive/25 bg-destructive/10 text-destructive dark:border-transparent dark:bg-destructive/25",
        outline: "text-foreground",
        success:
          "border-success/25 bg-success/10 text-success dark:border-transparent dark:bg-success/25",
        warning:
          "border-warning/30 bg-warning/10 text-warning dark:border-transparent dark:bg-warning/20",
        info: "border-info/25 bg-info/10 text-info dark:border-transparent dark:bg-info/25",
        muted:
          "border-border bg-muted text-muted-foreground dark:border-transparent",
        // Brighter, more saturated soft tints — same pill style as above but
        // with the vivid hue ramp and a touch more tint/border contrast. Used
        // for case/audit/approval status tags so the colors pop. The settings
        // pages keep the calmer base tints.
        successBright:
          "border-success-vivid/35 bg-success-vivid/15 text-success-vivid dark:border-transparent dark:bg-success-vivid/25",
        warningBright:
          "border-warning-vivid/35 bg-warning-vivid/15 text-warning-vivid dark:border-transparent dark:bg-warning-vivid/25",
        destructiveBright:
          "border-destructive-vivid/35 bg-destructive-vivid/15 text-destructive-vivid dark:border-transparent dark:bg-destructive-vivid/25",
        infoBright:
          "border-info/35 bg-info/15 text-info dark:border-transparent dark:bg-info/25",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  /**
   * Leading icon control: omit to use the variant's default status glyph,
   * pass a node to override it, or pass `false` to hide it (e.g. very tight
   * spaces where the color alone is enough).
   */
  readonly icon?: React.ReactNode | false;
}

function Badge({ className, variant, icon, children, ...props }: BadgeProps) {
  const DefaultIcon = badgeIcon(variant);
  const leading =
    icon === false
      ? null
      : icon !== undefined
        ? icon
        : DefaultIcon
          ? <DefaultIcon aria-hidden="true" />
          : null;
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      {leading}
      {children}
    </span>
  );
}

export { Badge, badgeVariants };
