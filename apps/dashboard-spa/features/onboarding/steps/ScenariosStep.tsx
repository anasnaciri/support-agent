import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Loader2 } from "lucide-react";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { cn } from "@/lib/utils";
import {
  PERMISSION_OPTIONS,
  REMEDY_ACTIONS,
} from "@/lib/resolution-action-labels";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Link } from "@/components/ui/link";
import type { WizardStepProps } from "../steps";

// Step 5. Read-only on purpose.
//
// The real Scenarios editor is a large surface (per-scenario action envelopes,
// permissions, playbook notes with @fact and /action references). Reproducing it
// here would be a second editor to keep in sync, and would ask a merchant who
// has been in the product for four minutes to make decisions they have no
// grounds for yet. The shipped defaults are good; what this step owes them is
// awareness that the playbooks EXIST and can be changed.

export function ScenariosStep({ onDone }: WizardStepProps) {
  const ctx = useWorkspaceCtx();
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  const policy = useQuery({
    queryKey: qk.resolutionPolicy(ctx.workspaceId),
    queryFn: () => api.resolutionPolicy(ctx),
  });

  if (policy.isLoading) {
    return <Loader2 className="size-5 animate-spin text-muted-foreground" />;
  }

  const scenarios = (policy.data?.scenarios ?? []).filter((s) => s.enabled);

  return (
    <div className="space-y-6">
      <ul className="divide-y rounded-lg border">
        {scenarios.map((s) => {
          const expanded = expandedKey === s.key;
          const panelId = `onboarding-scenario-${s.key}`;
          return (
            <li key={s.key}>
              <button
                type="button"
                aria-expanded={expanded}
                aria-controls={panelId}
                onClick={() => setExpandedKey(expanded ? null : s.key)}
                className="flex min-h-12 w-full items-center gap-3 px-4 py-3 text-left transition-[background-color,scale] duration-150 ease-out hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset active:scale-[0.96]"
              >
                <span className="min-w-0 flex-1 text-sm font-medium">
                  {s.label}
                </span>
                <Badge variant="secondary" className="tabular-nums">
                  {s.enabledActions.length === 0
                    ? "Replies only"
                    : `${s.enabledActions.length} action${
                        s.enabledActions.length === 1 ? "" : "s"
                      }`}
                </Badge>
                <ChevronDown
                  className={cn(
                    "size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-out",
                    expanded && "rotate-180",
                  )}
                  aria-hidden
                />
              </button>

              {expanded ? (
                <div
                  id={panelId}
                  role="region"
                  aria-label={`${s.label} playbook`}
                  className="space-y-4 border-t bg-muted/25 px-4 py-4"
                >
                  <section className="space-y-1.5">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Playbook notes
                    </h3>
                    <p className="whitespace-pre-wrap text-pretty text-sm leading-6">
                      {s.notes?.trim() || "No additional playbook notes."}
                    </p>
                  </section>

                  <section className="space-y-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Actions
                    </h3>
                    {s.enabledActions.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        Reply to the customer without taking a remedy action.
                      </p>
                    ) : (
                      <ul className="space-y-2">
                        {s.enabledActions.map((action) => {
                          const label =
                            REMEDY_ACTIONS.find(
                              (candidate) => candidate.tool === action.tool,
                            )?.label ?? action.tool;
                          const permission =
                            PERMISSION_OPTIONS.find(
                              (candidate) =>
                                candidate.value === action.permission,
                            )?.label ?? action.permission;
                          return (
                            <li
                              key={action.tool}
                              className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-background px-3 py-2 shadow-sm ring-1 ring-foreground/5"
                            >
                              <span className="text-sm font-medium">
                                {label}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {permission}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </section>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      <p className="text-sm text-muted-foreground">
        These playbooks decide how your agent handles each kind of request, and
        they already work out of the box. Skip this for now and come back once
        you've seen a few real tickets — that's when you'll know what to change.
        They live under{" "}
        <Link
          href="/settings/scenarios"
          className="font-medium underline underline-offset-4"
        >
          Settings → Scenarios
        </Link>
        .
      </p>

      <Button onClick={onDone}>These look good, continue</Button>
    </div>
  );
}
