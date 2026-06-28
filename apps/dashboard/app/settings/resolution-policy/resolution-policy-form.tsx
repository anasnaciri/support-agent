import type { ResolutionScenarioView } from "@support-agent/dashboard-contracts";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { fieldName } from "./parse-resolution";

/**
 * One editable card per scenario: which remedy actions the agent may take (and
 * whether each is automatic or needs approval), how to handle a supplier, and
 * free-text playbook notes. Immutable fields (key/label/recognition) are read-
 * only; the server action merges the editable fields onto the stored policy.
 */
export function ResolutionPolicyForm({
  scenarios,
}: {
  readonly scenarios: ReadonlyArray<ResolutionScenarioView>;
}) {
  return (
    <form action={saveResolutionPolicyAction} className="space-y-5">
      {scenarios.map((s) => {
        const byTool = new Map(
          s.enabledActions.map((a) => [a.tool, a.permission]),
        );
        return (
          <Card key={s.key}>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">{s.label}</CardTitle>
              {s.recognition ? (
                <p className="text-sm text-muted-foreground">{s.recognition}</p>
              ) : null}
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
                          name={fieldName(
                            s.key,
                            `action:${action.tool}:enabled`,
                          )}
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
                        name={fieldName(
                          s.key,
                          `action:${action.tool}:permission`,
                        )}
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
                  Reading the order, searching your knowledge base, and replying
                  to the customer are always on.
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
                      name={fieldName(s.key, "supplierMode")}
                      value={o.value}
                      defaultChecked={s.supplierMode === o.value}
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
                <Label htmlFor={fieldName(s.key, "notes")}>
                  Playbook notes
                </Label>
                <Textarea
                  id={fieldName(s.key, "notes")}
                  name={fieldName(s.key, "notes")}
                  rows={3}
                  defaultValue={s.notes ?? ""}
                  placeholder="How should the agent handle this? e.g. check tracking first, then offer a refund if it's genuinely lost."
                />
              </div>
            </CardContent>
          </Card>
        );
      })}

      <SubmitButton pendingLabel="Saving…">Save scenarios</SubmitButton>
    </form>
  );
}
