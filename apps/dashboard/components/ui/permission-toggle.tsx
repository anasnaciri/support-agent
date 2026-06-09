"use client";

import * as React from "react";
import { AlertTriangle, Check } from "lucide-react";

import { cn } from "@/lib/utils";

export interface PermissionToggleProps {
  /** Server action that sets the permission. Passed from the (server) page so
   *  this shared component doesn't import an app-route module. */
  readonly action: (formData: FormData) => void | Promise<void>;
  readonly agentId: string;
  readonly tool: string;
  /** Friendly action label, used in the confirm copy (e.g. "Send customer reply"). */
  readonly label: string;
  /** The effective current state: "ask" first, or "allow" (auto). */
  readonly current: "ask" | "allow";
}

// A two-state segmented control: "Ask first" (safe) vs "Auto" (dangerous).
// Each segment submits the server action immediately — there's no separate Save
// — and turning Auto ON requires an explicit confirm so it can't be flipped by
// a stray click. Auto is styled with the destructive palette so it reads as
// risky at a glance.
export const PermissionToggle = ({
  action,
  agentId,
  tool,
  label,
  current,
}: PermissionToggleProps) => {
  const isAuto = current === "allow";

  const confirmAuto = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (isAuto) return; // already auto — no confirm needed
    const ok = window.confirm(
      `Turn ON auto for “${label}”?\n\nThe agent will do this automatically, ` +
        `without asking you to approve it first.`,
    );
    if (!ok) e.preventDefault();
  };

  const segment =
    "inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1";

  return (
    <form action={action} className="inline-flex flex-col items-start gap-1.5">
      <input type="hidden" name="agentId" value={agentId} />
      <input type="hidden" name="tool" value={tool} />
      <div
        role="group"
        aria-label={`${label} permission`}
        className="inline-flex overflow-hidden rounded-md border border-input"
      >
        <button
          type="submit"
          name="permission"
          value="ask"
          aria-pressed={!isAuto}
          className={cn(
            segment,
            !isAuto
              ? "bg-primary text-primary-foreground"
              : "bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground",
          )}
        >
          {!isAuto ? <Check className="size-3.5" aria-hidden /> : null}
          Ask first
        </button>
        <button
          type="submit"
          name="permission"
          value="allow"
          onClick={confirmAuto}
          aria-pressed={isAuto}
          className={cn(
            segment,
            "border-l border-input",
            isAuto
              ? "bg-destructive text-destructive-foreground"
              : "bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground",
          )}
        >
          {isAuto ? <AlertTriangle className="size-3.5" aria-hidden /> : null}
          Auto
        </button>
      </div>
      {isAuto ? (
        <p className="flex items-center gap-1.5 text-xs font-medium text-destructive">
          <AlertTriangle className="size-3.5" aria-hidden />
          Runs automatically — no human approval.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Held for your approval before it runs.
        </p>
      )}
    </form>
  );
};
