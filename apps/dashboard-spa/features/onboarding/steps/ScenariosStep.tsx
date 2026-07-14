import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
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
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { WizardStepProps } from "../steps";
import type { ResolutionScenarioView } from "@support-agent/dashboard-contracts";

// Step 5. Compact editor over the same resolution-policy endpoint as Settings.

export function ScenariosStep({ onDone, canEdit }: WizardStepProps) {
  const ctx = useWorkspaceCtx();
  const qc = useQueryClient();
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<ReadonlyArray<ResolutionScenarioView> | null>(null);

  const policy = useQuery({
    queryKey: qk.resolutionPolicy(ctx.workspaceId),
    queryFn: () => api.resolutionPolicy(ctx),
  });

  useEffect(() => {
    if (drafts === null && policy.data) setDrafts(policy.data.scenarios);
  }, [drafts, policy.data]);

  const save = useMutation({
    mutationFn: async (next: ReadonlyArray<ResolutionScenarioView>) => {
      const result = await api.setResolutionPolicy(ctx, next);
      if (result.status !== 200) throw new Error("resolution policy rejected");
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.resolutionPolicy(ctx.workspaceId) });
      onDone();
    },
    onError: () => toast.warning("Couldn't save those playbooks. Please try again."),
  });

  const update = (key: string, fn: (scenario: ResolutionScenarioView) => ResolutionScenarioView) =>
    setDrafts((current) => current?.map((scenario) => scenario.key === key ? fn(scenario) : scenario) ?? current);

  if (policy.isLoading) {
    return <Loader2 className="size-5 animate-spin text-muted-foreground" />;
  }

  const scenarios = drafts ?? policy.data?.scenarios ?? [];

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
                  {!s.enabled ? "Inactive" : s.enabledActions.length === 0
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
                    <label className="flex min-h-10 cursor-pointer items-center gap-3 text-sm font-medium">
                      <input type="checkbox" checked={s.enabled} disabled={!canEdit}
                        onChange={(event) => { const enabled = event.currentTarget.checked; update(s.key, (current) => ({ ...current, enabled })); }}
                        className="size-4 rounded border-input accent-primary" />
                      Active playbook
                    </label>
                    {!s.builtin ? (
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="space-y-1.5">
                          <Label htmlFor={`label:${s.key}`}>Scenario name</Label>
                          <Input id={`label:${s.key}`} name={`label:${s.key}`} value={s.label} disabled={!canEdit}
                            onChange={(event) => { const label = event.currentTarget.value; update(s.key, (current) => ({ ...current, label })); }} />
                        </div>
                        <div className="space-y-1.5 sm:col-span-2">
                          <Label htmlFor={`recognition:${s.key}`}>When should this match?</Label>
                          <Textarea id={`recognition:${s.key}`} name={`recognition:${s.key}`} value={s.recognition ?? ""} disabled={!canEdit}
                            onChange={(event) => { const recognition = event.currentTarget.value || null; update(s.key, (current) => ({ ...current, recognition })); }}
                            rows={2} placeholder="Describe the customer request that belongs in this scenario." />
                        </div>
                      </div>
                    ) : null}
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Playbook notes
                    </h3>
                    <Textarea name={`notes:${s.key}`} value={s.notes ?? ""} disabled={!canEdit}
                      onChange={(event) => { const notes = event.currentTarget.value || null; update(s.key, (current) => ({ ...current, notes })); }}
                      rows={5} placeholder="Tell the agent how to handle this scenario." />
                  </section>

                  <section className="space-y-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Actions
                    </h3>
                    <ul className="space-y-2">
                        {REMEDY_ACTIONS.map((action) => {
                          const configured = s.enabledActions.find((candidate) => candidate.tool === action.tool);
                          return (
                            <li
                              key={action.tool}
                              className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-background px-3 py-2 shadow-sm ring-1 ring-foreground/5"
                            >
                              <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm font-medium">
                                <input type="checkbox" checked={Boolean(configured)} disabled={!canEdit}
                                  onChange={(event) => { const enabled = event.currentTarget.checked; update(s.key, (current) => ({
                                    ...current,
                                    enabledActions: enabled
                                      ? [...current.enabledActions, { tool: action.tool, permission: "ask" }]
                                      : current.enabledActions.filter((candidate) => candidate.tool !== action.tool),
                                  })); }} className="size-4 rounded border-input accent-primary" />
                                {action.label}
                              </label>
                              <NativeSelect name={`permission:${s.key}:${action.tool}`} value={configured?.permission ?? "ask"}
                                disabled={!canEdit || !configured}
                                onChange={(event) => { const permission = event.currentTarget.value as "ask" | "allow"; update(s.key, (current) => ({ ...current,
                                  enabledActions: current.enabledActions.map((candidate) => candidate.tool === action.tool
                                    ? { ...candidate, permission } : candidate),
                                })); }} className="w-44">
                                {PERMISSION_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                              </NativeSelect>
                            </li>
                          );
                        })}
                      </ul>
                  </section>
                  <section className="space-y-1.5">
                    <Label htmlFor={`fulfillment:${s.key}`}>Fulfillment partner</Label>
                    <NativeSelect id={`fulfillment:${s.key}`} value={s.fulfillmentOperatorMode} disabled={!canEdit}
                      onChange={(event) => { const fulfillmentOperatorMode = event.currentTarget.value as ResolutionScenarioView["fulfillmentOperatorMode"]; update(s.key, (current) => ({ ...current,
                        fulfillmentOperatorMode,
                      })); }}>
                      <option value="escalate_and_wait">Escalate and wait</option>
                      <option value="notify_and_proceed">Notify and keep helping</option>
                      <option value="none">Don't involve a fulfillment partner</option>
                    </NativeSelect>
                  </section>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      <p className="text-sm text-muted-foreground">
        These playbooks already work out of the box. You can refine them here or
        later under{" "}
        <Link
          href="/settings/scenarios"
          className="font-medium underline underline-offset-4"
        >
          Settings → Scenarios
        </Link>
        .
      </p>

      <Button onClick={() => drafts && save.mutate(drafts)} disabled={!canEdit || !drafts || save.isPending}>
        {save.isPending ? "Saving…" : "Save and continue"}
      </Button>
    </div>
  );
}
