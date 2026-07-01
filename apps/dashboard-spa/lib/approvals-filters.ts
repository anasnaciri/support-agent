// Pure helpers backing the multi-select approvals filters. The approvals page
// is a server component whose `<form method="get">` ships each picker's
// selection as repeated query keys; Next.js then hands them back as
// `string | string[] | undefined`. Keeping the normalization here makes it
// unit-testable and keeps the page declarative.

export interface ApprovalsFilterValues {
  readonly status: ReadonlyArray<string>;
  readonly risk: ReadonlyArray<string>;
  readonly tool: ReadonlyArray<string>;
  readonly agent: ReadonlyArray<string>;
}

/** Normalize a searchParams value into a clean list of non-empty values. */
export const toFilterValues = (
  raw: string | ReadonlyArray<string> | undefined,
): string[] => {
  if (raw === undefined) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.filter((v): v is string => typeof v === "string" && v.length > 0);
};

/**
 * The status filter defaults to "pending" when the param is absent entirely
 * (fresh navigation / Reset) — that's the actionable landing view. An explicit
 * selection is taken as-is; the "any" sentinel is how the picker asks to drop
 * the status filter and see every status.
 */
export const resolveStatusValues = (
  raw: string | ReadonlyArray<string> | undefined,
): string[] => (raw === undefined ? ["pending"] : toFilterValues(raw));

/** True when the filter set matches the default landing view (pending-only). */
export const isDefaultApprovalsFilter = (f: ApprovalsFilterValues): boolean =>
  f.risk.length === 0 &&
  f.tool.length === 0 &&
  f.agent.length === 0 &&
  f.status.length === 1 &&
  f.status[0] === "pending";

/**
 * The [key, value] pairs that carry the active filter through pagination
 * links/forms — one pair per selected value. Status is omitted when it's the
 * pending default so default-view URLs stay clean (the server re-derives it).
 */
export const approvalsHiddenParams = (
  f: ApprovalsFilterValues,
): ReadonlyArray<readonly [string, string]> => {
  const statusIsDefault = f.status.length === 1 && f.status[0] === "pending";
  return [
    ...(statusIsDefault
      ? []
      : f.status.map((v) => ["status", v] as const)),
    ...f.risk.map((v) => ["risk", v] as const),
    ...f.tool.map((v) => ["tool", v] as const),
    ...f.agent.map((v) => ["agent", v] as const),
  ];
};

/** Trigger label for a multi-select: the empty placeholder, the picked labels
 *  (up to two), or a count once it gets crowded. */
export const multiSelectLabel = (
  selectedLabels: ReadonlyArray<string>,
  emptyLabel: string,
): string => {
  if (selectedLabels.length === 0) return emptyLabel;
  if (selectedLabels.length <= 2) return selectedLabels.join(", ");
  return `${selectedLabels.length} selected`;
};
