"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";

import type { ResolutionScenarioView } from "@support-agent/dashboard-contracts";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Separator } from "@/components/ui/separator";
import { SubmitButton } from "@/components/ui/submit-button";
import { Textarea } from "@/components/ui/textarea";

import {
  PERMISSION_OPTIONS,
  REMEDY_ACTIONS,
  SUPPLIER_MODE_OPTIONS,
} from "./action-labels";
import { saveResolutionPolicyAction } from "./actions";
import {
  NEW_SCENARIO_PREFIX,
  SCENARIO_KEYS_FIELD,
  fieldName,
} from "./parse-resolution";

interface CustomCard {
  /** Stable React key + form-field prefix (a `custom_*` or `__new_*` key). */
  readonly formKey: string;
  /** The saved scenario this card edits, or null for a freshly-added one. */
  readonly initial: ResolutionScenarioView | null;
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
        {/* Remedy actions the agent may take for this scenario. */}
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
            Reading the order, searching your knowledge base, and replying to the
            customer are always on.
          </p>
        </fieldset>

        <Separator />

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
 * the server action can reconstruct the list (built-ins, existing customs, and
 * freshly-added `__new_*` cards alike) from the submitted FormData.
 */
export function ResolutionPolicyForm({
  scenarios,
}: {
  readonly scenarios: ReadonlyArray<ResolutionScenarioView>;
}) {
  const builtins = scenarios.filter((s) => s.builtin);
  const [customs, setCustoms] = useState<ReadonlyArray<CustomCard>>(() =>
    scenarios
      .filter((s) => !s.builtin)
      .map((s) => ({ formKey: s.key, initial: s })),
  );
  const [nextId, setNextId] = useState(0);

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

  return (
    <form action={saveResolutionPolicyAction} className="space-y-5">
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

      <SubmitButton pendingLabel="Saving…">Save scenarios</SubmitButton>
    </form>
  );
}
