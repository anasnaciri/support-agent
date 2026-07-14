import { Check, SkipForward } from "lucide-react";
import type {
  OnboardingStateView,
  OnboardingStepKeyView,
} from "@support-agent/dashboard-contracts";

import { cn } from "@/lib/utils";
import type { WizardStepDef } from "./steps";

// The wizard's progress rail. Doubles as navigation: a merchant can jump back
// to a step they've passed (or ahead to one they'd rather do first) — the
// wizard records what's done, it doesn't imprison anyone in the order.
//
// Below `md` it collapses to a horizontal row of dots so the step content owns
// the narrow viewport.

export function WizardStepper({
  steps,
  current,
  statuses,
  onSelect,
}: {
  readonly steps: ReadonlyArray<WizardStepDef>;
  readonly current: OnboardingStepKeyView;
  readonly statuses: OnboardingStateView["steps"];
  readonly onSelect: (key: OnboardingStepKeyView) => void;
}) {
  return (
    <nav aria-label="Setup steps">
      {/* Compact progress on small screens. */}
      <ol className="flex flex-wrap gap-1.5 md:hidden">
        {steps.map((step) => {
          const status = statuses[step.key];
          return (
            <li key={step.key}>
              <button
                type="button"
                onClick={() => onSelect(step.key)}
                aria-label={step.title}
                aria-current={step.key === current ? "step" : undefined}
                className={cn(
                  "size-2.5 rounded-full transition-colors",
                  step.key === current
                    ? "bg-primary"
                    : status === "done"
                      ? "bg-primary/40"
                      : status === "skipped"
                        ? "bg-muted-foreground/30"
                        : "bg-muted",
                )}
              />
            </li>
          );
        })}
      </ol>

      <ol className="hidden md:block md:space-y-0.5">
        {steps.map((step, i) => {
          const status = statuses[step.key];
          const active = step.key === current;
          return (
            <li key={step.key}>
              <button
                type="button"
                onClick={() => onSelect(step.key)}
                aria-current={active ? "step" : undefined}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                  active
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )}
              >
                <span
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] tabular-nums",
                    status === "done"
                      ? "border-primary bg-primary text-primary-foreground"
                      : active
                        ? "border-foreground/40"
                        : "border-muted-foreground/30",
                  )}
                >
                  {status === "done" ? (
                    <Check className="size-3" />
                  ) : status === "skipped" ? (
                    <SkipForward className="size-2.5" />
                  ) : (
                    i + 1
                  )}
                </span>
                <span className="truncate">{step.title}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
