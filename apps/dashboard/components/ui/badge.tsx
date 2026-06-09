import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
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
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
