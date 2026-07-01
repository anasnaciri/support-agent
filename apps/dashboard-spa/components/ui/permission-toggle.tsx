"use client";

import * as React from "react";
import { AlertTriangle, Check } from "lucide-react";

import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

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
// a stray click. The confirm is a branded AlertDialog (not the native
// window.confirm) so it matches the dashboard. Because the dialog content is
// portaled outside this <form>, the confirm button re-associates with the form
// via the `form={formId}` attribute and carries permission=allow on submit.
// Auto is styled with the destructive palette so it reads as risky at a glance.
export const PermissionToggle = ({
  action,
  agentId,
  tool,
  label,
  current,
}: PermissionToggleProps) => {
  const isAuto = current === "allow";
  const formId = React.useId();

  const segment =
    "inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1";

  return (
    <form
      id={formId}
      action={action}
      className="inline-flex flex-col items-start gap-1.5"
    >
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
        {isAuto ? (
          // Already auto — the segment is just the pressed state; re-affirming
          // would be a no-op, so it isn't a button that does anything.
          <span
            aria-pressed
            className={cn(
              segment,
              "border-l border-input bg-destructive text-destructive-foreground",
            )}
          >
            <AlertTriangle className="size-3.5" aria-hidden />
            Auto
          </span>
        ) : (
          <AlertDialog>
            <AlertDialogTrigger
              className={cn(
                segment,
                "border-l border-input bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              Auto
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Turn on auto for “{label}”?</AlertDialogTitle>
                <AlertDialogDescription>
                  The agent will do this automatically, without asking you to
                  approve it first.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  type="submit"
                  form={formId}
                  name="permission"
                  value="allow"
                  className={buttonVariants({ variant: "destructive" })}
                >
                  Turn on auto
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
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
