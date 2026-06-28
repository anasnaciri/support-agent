// Pure helpers backing the cases-list status filter. Mirrors approvals-filters.ts
// but the cases page defaults to NO filter (show every status) rather than a
// pending-only landing view. The status picker ships its selection as repeated
// `status` query keys via a `<form method="get">`; the page normalizes them with
// `toFilterValues` (reused from approvals-filters) and these helpers carry the
// active selection through pagination and decide when "Reset" is shown.

export { toFilterValues } from "./approvals-filters";

/** True when no status is selected — the default landing view (all statuses). */
export const isDefaultCasesFilter = (status: ReadonlyArray<string>): boolean =>
  status.length === 0;

/**
 * The [key, value] pairs that carry the active status filter through pagination
 * links/forms — one pair per selected status. Empty when nothing is selected so
 * default-view URLs stay clean.
 */
export const casesHiddenParams = (
  status: ReadonlyArray<string>,
): ReadonlyArray<readonly [string, string]> =>
  status.map((v) => ["status", v] as const);
