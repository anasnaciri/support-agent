import type {
  ResolutionScenarioView,
  ScenarioActionPermissionView,
  SupplierModeView,
} from "@support-agent/dashboard-contracts";

import { REMEDY_ACTIONS } from "./action-labels";

// Field naming for the scenario form. Keys are the per-card "form key" (a
// built-in's real key, an existing custom's `custom_*` key, or a freshly-added
// card's temporary `__new_*` key); the "::" separator never collides with them.
// Pure so the parse below is unit-testable without React/FormData.
export const fieldName = (key: string, suffix: string): string =>
  `${key}::${suffix}`;

/** Hidden input carrying the JSON array of every card's form key, in order. */
export const SCENARIO_KEYS_FIELD = "__scenarioKeys";

/** Form-key prefix for a custom card the merchant just added (not yet saved).
 *  The parser strips it to an empty key so the server assigns a stable one. */
export const NEW_SCENARIO_PREFIX = "__new_";

/** Persisted custom scenarios are namespaced with this prefix server-side. */
const CUSTOM_PREFIX = "custom_";

const SUPPLIER_MODES: ReadonlySet<string> = new Set([
  "escalate_and_wait",
  "notify_and_proceed",
  "none",
]);

const isCustomFormKey = (formKey: string): boolean =>
  formKey.startsWith(CUSTOM_PREFIX) || formKey.startsWith(NEW_SCENARIO_PREFIX);

/**
 * Build the scenarios to save from the submitted form. The hidden manifest
 * (`SCENARIO_KEYS_FIELD`) lists every rendered card's form key; for each we
 * read its editable fields. A card's nature is derived from its key: built-in
 * (no prefix), an existing custom (`custom_*`), or a freshly-added custom
 * (`__new_*`, whose outgoing key is blanked so the server assigns one). The api
 * re-sanitizes through the server-side decoder, which is the authority on
 * built-in immutability and custom-key assignment — so what's read here is a
 * faithful payload, not the final word. Pure: `get(name)` returns the form
 * value or null (a checkbox is "on" when checked, null when unchecked).
 */
export const parseResolutionForm = (
  get: (name: string) => string | null,
): ReadonlyArray<ResolutionScenarioView> => {
  const manifestRaw = get(SCENARIO_KEYS_FIELD);
  let formKeys: string[] = [];
  try {
    const parsed = manifestRaw ? JSON.parse(manifestRaw) : [];
    if (Array.isArray(parsed)) {
      formKeys = parsed.filter((k): k is string => typeof k === "string");
    }
  } catch {
    formKeys = [];
  }

  return formKeys.map((formKey) => {
    const custom = isCustomFormKey(formKey);

    const enabledActions = REMEDY_ACTIONS.flatMap((action) => {
      const on =
        get(fieldName(formKey, `action:${action.tool}:enabled`)) === "on";
      if (!on) return [];
      const permRaw = get(fieldName(formKey, `action:${action.tool}:permission`));
      const permission: ScenarioActionPermissionView =
        permRaw === "allow" ? "allow" : "ask";
      return [{ tool: action.tool, permission }];
    });

    const smRaw = get(fieldName(formKey, "supplierMode"));
    const supplierMode: SupplierModeView =
      smRaw && SUPPLIER_MODES.has(smRaw) ? (smRaw as SupplierModeView) : "none";

    const notesRaw = get(fieldName(formKey, "notes"));
    const notes = typeof notesRaw === "string" ? notesRaw.trim() : "";

    const enabled = get(fieldName(formKey, "enabled")) === "on";

    // Built-ins carry label/recognition as hidden inputs; customs as editable
    // fields. The outgoing key is blanked for a brand-new card.
    const labelRaw = custom
      ? get(fieldName(formKey, "label"))
      : get(fieldName(formKey, "__label"));
    const label = typeof labelRaw === "string" ? labelRaw.trim() : "";

    const recognitionRaw = custom
      ? get(fieldName(formKey, "recognition"))
      : get(fieldName(formKey, "__recognition"));
    const recognition =
      typeof recognitionRaw === "string" && recognitionRaw.trim().length > 0
        ? recognitionRaw.trim()
        : null;

    const outgoingKey = formKey.startsWith(NEW_SCENARIO_PREFIX) ? "" : formKey;

    return {
      key: outgoingKey,
      label,
      recognition,
      builtin: !custom,
      enabled,
      enabledActions,
      supplierMode,
      notes: notes.length > 0 ? notes : null,
    };
  });
};
