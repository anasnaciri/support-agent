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
