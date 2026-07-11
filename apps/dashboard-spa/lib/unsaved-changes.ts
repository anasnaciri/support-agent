/**
 * A page can hold several independent forms (the scenarios list, each facts
 * card), and any one of them being unsaved should hold the user back. The page
 * owns the flags; each form reports its own id.
 */
export type DirtyFlags = Readonly<Record<string, boolean>>;

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
