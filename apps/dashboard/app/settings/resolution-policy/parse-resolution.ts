import type {
  ResolutionScenarioView,
  ScenarioActionPermissionView,
  SupplierModeView,
} from "@support-agent/dashboard-contracts";

import { REMEDY_ACTIONS } from "./action-labels";

// Field naming for the scenario form. Keys are snake_case scenario ids; the
// "::" separator never collides with them. Pure so the parse below is unit-
// testable without React/FormData.
export const fieldName = (key: string, suffix: string): string =>
  `${key}::${suffix}`;

const SUPPLIER_MODES: ReadonlySet<string> = new Set([
  "escalate_and_wait",
  "notify_and_proceed",
  "none",
]);

/**
 * Build the saved scenarios from the form values + the STORED scenarios. The
 * immutable fields (key/label/recognition/builtin) come from `stored` — the
 * form can only change `enabledActions`, `supplierMode`, and `notes`. Pure:
 * `get(name)` returns the form value or null (a checkbox is "on" when checked,
 * null when unchecked).
 */
export const parseResolutionForm = (
  get: (name: string) => string | null,
  stored: ReadonlyArray<ResolutionScenarioView>,
): ReadonlyArray<ResolutionScenarioView> =>
  stored.map((s) => {
    const enabledActions = REMEDY_ACTIONS.flatMap((action) => {
      const on = get(fieldName(s.key, `action:${action.tool}:enabled`)) === "on";
      if (!on) return [];
      const permRaw = get(fieldName(s.key, `action:${action.tool}:permission`));
      const permission: ScenarioActionPermissionView =
        permRaw === "allow" ? "allow" : "ask";
      return [{ tool: action.tool, permission }];
    });

    const smRaw = get(fieldName(s.key, "supplierMode"));
    const supplierMode: SupplierModeView =
      smRaw && SUPPLIER_MODES.has(smRaw)
        ? (smRaw as SupplierModeView)
        : s.supplierMode;

    const notesRaw = get(fieldName(s.key, "notes"));
    const notes = typeof notesRaw === "string" ? notesRaw.trim() : "";

    const enabled = get(fieldName(s.key, "enabled")) === "on";

    return {
      key: s.key,
      label: s.label,
      recognition: s.recognition,
      builtin: s.builtin,
      enabled,
      enabledActions,
      supplierMode,
      notes: notes.length > 0 ? notes : null,
    };
  });
