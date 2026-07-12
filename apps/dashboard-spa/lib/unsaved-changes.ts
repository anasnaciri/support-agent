import { useCallback, useEffect, useState } from "react";

/**
 * A page can hold several independent forms (the scenarios list, each facts
 * card), and any one of them being unsaved should hold the user back. The page
 * owns the flags; each form reports its own id.
 */
export type DirtyFlags = Readonly<Record<string, boolean>>;

/** How a form tells its page it has (or no longer has) edits to save. */
export type ReportDirty = (id: string, dirty: boolean) => void;

/** Returns the same object when nothing changed, so a React setState bails out. */
export const setDirtyFlag = (
  flags: DirtyFlags,
  id: string,
  dirty: boolean,
): DirtyFlags =>
  (flags[id] ?? false) === dirty ? flags : { ...flags, [id]: dirty };

export const hasUnsavedChanges = (flags: DirtyFlags): boolean =>
  Object.values(flags).some(Boolean);

/** Field-by-field compare of a controlled form against the values last saved. */
export const formValuesDirty = <T extends object>(
  saved: T,
  current: T,
): boolean => {
  const now = new Map(Object.entries(current));
  return Object.entries(saved).some(([key, value]) => now.get(key) !== value);
};

/**
 * The same compare, but tolerant of padding the save would strip anyway — the
 * settings forms all `.trim()` on submit, so trailing spaces are not a change
 * worth warning about.
 */
export const trimmedFormValuesDirty = <T extends object>(
  saved: T,
  current: T,
): boolean => {
  const trim = (v: unknown): unknown => (typeof v === "string" ? v.trim() : v);
  const now = new Map(
    Object.entries(current).map(([key, value]) => [key, trim(value)]),
  );
  return Object.entries(saved).some(
    ([key, value]) => now.get(key) !== trim(value),
  );
};

/**
 * Page-level registry for a page whose forms save separately: each reports
 * under its own id, and the page is dirty while any one of them is.
 */
export const useDirtyFlags = (): {
  readonly dirty: boolean;
  readonly reportDirty: ReportDirty;
} => {
  const [flags, setFlags] = useState<DirtyFlags>({});
  const reportDirty = useCallback<ReportDirty>(
    (id, dirty) => setFlags((current) => setDirtyFlag(current, id, dirty)),
    [],
  );
  return { dirty: hasUnsavedChanges(flags), reportDirty };
};

/** Report `dirty` under `id` while mounted; report clean on the way out. */
export const useReportDirty = (
  report: ReportDirty,
  id: string,
  dirty: boolean,
): void => {
  useEffect(() => {
    report(id, dirty);
  }, [report, id, dirty]);
  useEffect(() => () => report(id, false), [report, id]);
};
