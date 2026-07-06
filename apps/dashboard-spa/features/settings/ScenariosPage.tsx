import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Trash2, Workflow } from "lucide-react";
import { toast } from "sonner";

import type { ResolutionScenarioView } from "@support-agent/dashboard-contracts";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { useRequirePermission } from "@/lib/require-permission";
import {
  PERMISSION_OPTIONS,
  REMEDY_ACTIONS,
  SUPPLIER_MODE_OPTIONS,
} from "@/lib/resolution-action-labels";
import {
  NEW_SCENARIO_PREFIX,
  SCENARIO_KEYS_FIELD,
  fieldName,
  parseResolutionForm,
} from "@/lib/parse-resolution";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { SettingsBreadcrumb } from "@/components/settings-breadcrumb";

/**
 * Per-scenario remedy-action control is HIDDEN for now (2026-06-28): tools and
 * permissions are configured once on the agent (Settings → Agents), not per
 * scenario. The editor UI below is kept behind this flag — flip to `true` to
 * resurface fine-grained per-scenario tool control. While hidden, each card
 * round-trips its stored `enabledActions` through hidden inputs so saving the
 * policy never wipes them. See todo "RESURFACE LATER".
 */
const SHOW_PER_SCENARIO_ACTIONS = false;

interface CustomCard {
  /** Stable React key + form-field prefix (a `custom_*` or `__new_*` key). */
  readonly formKey: string;
  /** The saved scenario this card edits, or null for a freshly-added one. */
  readonly initial: ResolutionScenarioView | null;
}

/**
 * On/off switch for routing new tickets to the resolution agent. Fires the toggle
 * mutation on change (no Save button); the page's resolution-policy query
 * invalidates so the status help text refreshes in place.
 */
function ResolutionAgentToggle({ enabled }: { readonly enabled: boolean }) {
  const ctx = useWorkspaceCtx();
  const qc = useQueryClient();
  const [checked, setChecked] = useState(enabled);
  useEffect(() => setChecked(enabled), [enabled]);

  const toggleM = useMutation({
    mutationFn: (next: boolean) => api.setResolutionAgentEnabled(ctx, next),
    onError: () => {
      toast.warning("Something went wrong. Please try again.");
    },
    onSettled: () => {
      void qc.invalidateQueries({
        queryKey: qk.resolutionPolicy(ctx.workspaceId),
      });
    },
  });

  return (
    <label className="flex cursor-pointer items-center gap-3">
      <input
        type="checkbox"
        name="enabled"
        checked={checked}
        disabled={toggleM.isPending}
        onChange={(e) => {
          const next = e.currentTarget.checked;
          setChecked(next);
          toggleM.mutate(next);
        }}
        className="size-4 rounded border-input accent-primary"
      />
      <span className="text-sm font-medium">
        Route new tickets to the resolution agent
      </span>
    </label>
  );
}

/**
 * One scenario card. Built-in cards show a read-only header (their name + when
 * they apply are immutable, forced server-side) and carry those values as
 * hidden inputs. Custom cards make the name + recognition editable and add a
 * remove button. The editable fields — which remedy actions the agent may take
 * and whether each needs approval, supplier handling, the Active toggle, and
 * free-text notes — are identical for both.
 */
function ScenarioCard({
  formKey,
  scenario,
  onRemove,
}: {
  readonly formKey: string;
  readonly scenario: ResolutionScenarioView | null;
  readonly onRemove?: () => void;
}) {
  const custom = onRemove != null;
  const byTool = new Map(
    (scenario?.enabledActions ?? []).map((a) => [a.tool, a.permission]),
  );
  const defaultSupplierMode = scenario?.supplierMode ?? "none";

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {custom ? (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor={fieldName(formKey, "label")}>
                    Scenario name
                  </Label>
                  <Input
                    id={fieldName(formKey, "label")}
                    name={fieldName(formKey, "label")}
                    defaultValue={scenario?.label ?? ""}
                    placeholder="e.g. Wholesale order question"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={fieldName(formKey, "recognition")}>
                    When should the agent treat a message as this?
                  </Label>
                  <Textarea
                    id={fieldName(formKey, "recognition")}
                    name={fieldName(formKey, "recognition")}
                    rows={2}
                    defaultValue={scenario?.recognition ?? ""}
                    placeholder="Describe it in plain language, e.g. a bulk / B2B buyer asking about a large order."
                    required
                  />
                </div>
              </div>
            ) : (
              <>
                <CardTitle className="text-base">{scenario?.label}</CardTitle>
                {scenario?.recognition ? (
                  <p className="text-sm text-muted-foreground">
                    {scenario.recognition}
                  </p>
                ) : null}
                {/* Immutable fields ride along so the saved payload is faithful;
                    the server re-derives them from the seeded defaults anyway. */}
                <input
                  type="hidden"
                  name={fieldName(formKey, "__label")}
                  value={scenario?.label ?? ""}
                />
                <input
                  type="hidden"
                  name={fieldName(formKey, "__recognition")}
                  value={scenario?.recognition ?? ""}
                />
              </>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                name={fieldName(formKey, "enabled")}
                defaultChecked={scenario ? scenario.enabled : true}
                className="size-4 rounded border-input accent-primary"
              />
              <span className="font-medium">Active</span>
            </label>
            {custom ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={onRemove}
                aria-label="Remove scenario"
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Per-scenario remedy actions. HIDDEN 2026-06-28 (tools configured once
            on the agent now); the editor is kept behind SHOW_PER_SCENARIO_ACTIONS
            and the stored enabledActions are round-tripped via hidden inputs so a
            save never wipes them. */}
        {SHOW_PER_SCENARIO_ACTIONS ? (
          <>
            <fieldset className="space-y-3">
              <legend className="text-sm font-medium">
                Actions the agent can take
              </legend>
              {REMEDY_ACTIONS.map((action) => {
                const enabled = byTool.has(action.tool);
                const permission = byTool.get(action.tool) ?? "ask";
                return (
                  <div
                    key={action.tool}
                    className="flex flex-wrap items-center gap-x-3 gap-y-2"
                  >
                    <label className="flex flex-1 items-start gap-2">
                      <input
                        type="checkbox"
                        name={fieldName(formKey, `action:${action.tool}:enabled`)}
                        defaultChecked={enabled}
                        className="mt-0.5 size-4 rounded border-input accent-primary"
                      />
                      <span className="text-sm">
                        <span className="font-medium">{action.label}</span>
                        <span className="block text-xs text-muted-foreground">
                          {action.help}
                        </span>
                      </span>
                    </label>
                    <NativeSelect
                      name={fieldName(formKey, `action:${action.tool}:permission`)}
                      defaultValue={permission}
                      aria-label={`${action.label} — approval`}
                      className="w-44"
                    >
                      {PERMISSION_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                );
              })}
              <p className="text-xs text-muted-foreground">
                Reading the order, searching your knowledge base, and replying to
                the customer are always on.
              </p>
            </fieldset>

            <Separator />
          </>
        ) : (
          Array.from(byTool.entries()).flatMap(([tool, perm]) => [
            <input
              key={`${tool}:enabled`}
              type="hidden"
              name={fieldName(formKey, `action:${tool}:enabled`)}
              value="on"
            />,
            <input
              key={`${tool}:permission`}
              type="hidden"
              name={fieldName(formKey, `action:${tool}:permission`)}
              value={perm}
            />,
          ])
        )}

        {/* Supplier handling. */}
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">
            When a supplier is involved
          </legend>
          {SUPPLIER_MODE_OPTIONS.map((o) => (
            <label key={o.value} className="flex items-start gap-2">
              <input
                type="radio"
                name={fieldName(formKey, "supplierMode")}
                value={o.value}
                defaultChecked={defaultSupplierMode === o.value}
                className="mt-0.5 size-4 border-input accent-primary"
              />
              <span className="text-sm">
                <span className="font-medium">{o.label}</span>
                <span className="block text-xs text-muted-foreground">
                  {o.help}
                </span>
              </span>
            </label>
          ))}
        </fieldset>

        <Separator />

        {/* Free-text playbook. */}
        <div className="space-y-1.5">
          <Label htmlFor={fieldName(formKey, "notes")}>Playbook notes</Label>
          <Textarea
            id={fieldName(formKey, "notes")}
            name={fieldName(formKey, "notes")}
            rows={3}
            defaultValue={scenario?.notes ?? ""}
            placeholder="How should the agent handle this? e.g. check tracking first, then offer a refund if it's genuinely lost."
          />
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * The scenario editor. Built-in cards are fixed; merchants can add their own
 * scenarios (name + when-it-applies + the same action/supplier/notes controls)
 * and remove the custom ones. A hidden manifest lists every card's form key so
 * the submit handler can reconstruct the list (built-ins, existing customs, and
 * freshly-added `__new_*` cards alike) from the submitted FormData.
 */
function ResolutionPolicyForm({
  scenarios,
}: {
  readonly scenarios: ReadonlyArray<ResolutionScenarioView>;
}) {
  const ctx = useWorkspaceCtx();
  const qc = useQueryClient();
  const builtins = scenarios.filter((s) => s.builtin);
  const [customs, setCustoms] = useState<ReadonlyArray<CustomCard>>(() =>
    scenarios
      .filter((s) => !s.builtin)
      .map((s) => ({ formKey: s.key, initial: s })),
  );
  const [nextId, setNextId] = useState(0);

  const saveM = useMutation({
    mutationFn: (next: ReadonlyArray<ResolutionScenarioView>) =>
      api.setResolutionPolicy(ctx, next),
    onSuccess: () => {
      toast.success("Scenarios saved.");
      void qc.invalidateQueries({
        queryKey: qk.resolutionPolicy(ctx.workspaceId),
      });
    },
    onError: () => {
      toast.warning("Something went wrong. Please try again.");
    },
  });

  const addCustom = () => {
    setCustoms((cs) => [
      ...cs,
      { formKey: `${NEW_SCENARIO_PREFIX}${nextId}`, initial: null },
    ]);
    setNextId((n) => n + 1);
  };
  const removeCustom = (formKey: string) =>
    setCustoms((cs) => cs.filter((c) => c.formKey !== formKey));

  const manifest = JSON.stringify([
    ...builtins.map((s) => s.key),
    ...customs.map((c) => c.formKey),
  ]);

  // The Next server action parsed FormData through parseResolutionForm; here we
  // read the same FormData off the submitted form and hand the typed payload
  // straight to the api. The api's decoder remains the authority on built-in
  // immutability and custom-key assignment.
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const get = (name: string): string | null => {
      const v = fd.get(name);
      return typeof v === "string" ? v : null;
    };
    saveM.mutate(parseResolutionForm(get));
  };

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <input type="hidden" name={SCENARIO_KEYS_FIELD} value={manifest} />

      {builtins.map((s) => (
        <ScenarioCard key={s.key} formKey={s.key} scenario={s} />
      ))}

      {customs.map((c) => (
        <ScenarioCard
          key={c.formKey}
          formKey={c.formKey}
          scenario={c.initial}
          onRemove={() => removeCustom(c.formKey)}
        />
      ))}

      <Button
        type="button"
        variant="outline"
        onClick={addCustom}
        className="w-full"
      >
        <Plus className="size-4" aria-hidden />
        Add scenario
      </Button>

      <Button type="submit" disabled={saveM.isPending}>
        {saveM.isPending ? (
          <Loader2 className="size-4 animate-spin" aria-hidden />
        ) : null}
        {saveM.isPending ? "Saving…" : "Save scenarios"}
      </Button>
    </form>
  );
}

export function ScenariosPage() {
  const allowed = useRequirePermission("settings.agents");
  const ctx = useWorkspaceCtx();

  const { data: policy, isLoading } = useQuery({
    queryKey: qk.resolutionPolicy(ctx.workspaceId),
    queryFn: () => api.resolutionPolicy(ctx),
    enabled: allowed,
  });

  if (!allowed) return null;

  if (isLoading || !policy) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  return (
    <div className="space-y-6">
      <SettingsBreadcrumb current="Scenarios" />

      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Scenarios</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A single agent that resolves tickets end-to-end, steered by the
          scenarios below. When it&apos;s on, triage routes a matching ticket to
          it; it gathers what it needs, takes the actions you&apos;ve allowed,
          and drafts the customer reply — pausing for your approval on anything
          you marked <em>Ask me first</em>. Leave it off to keep today&apos;s
          routing.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Workflow className="size-4" aria-hidden />
            Status
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <ResolutionAgentToggle enabled={policy.resolutionAgentEnabled} />
          <p className="mt-2 text-xs text-muted-foreground">
            {policy.resolutionAgentEnabled
              ? "On — new matching tickets go to the resolution agent."
              : "Off — tickets route to the built-in specialists as before."}
          </p>
        </CardContent>
      </Card>

      <div>
        <h2 className="text-lg font-semibold tracking-tight">Scenarios</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          For each situation, choose what the agent may do and whether it acts
          automatically or asks you first. The built-in scenarios cover the
          common tickets; add your own for anything specific to your store —
          describe when it applies and the agent will route matching messages to
          it.
        </p>
      </div>

      {!policy.resolutionAgentEnabled ? (
        <Alert variant="info">
          <AlertDescription>
            These settings take effect only while the resolution agent is on.
          </AlertDescription>
        </Alert>
      ) : null}

      <ResolutionPolicyForm scenarios={policy.scenarios} />
    </div>
  );
}
