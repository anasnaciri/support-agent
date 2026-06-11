// Pure roving-focus math for the MultiSelect listbox (U13). Framework-free so
// it's unit-testable; components/ui/multi-select.tsx is thin glue around it.

/**
 * The option index to focus after an ArrowUp (-1) / ArrowDown (+1) keypress.
 * `current` is -1 when no option is focused yet (focus still on the trigger):
 * ArrowDown enters at the first option, ArrowUp at the last. Movement clamps
 * at the ends (no wrap). Returns -1 for an empty list.
 */
export const nextOptionIndex = (
  current: number,
  delta: 1 | -1,
  count: number,
): number => {
  if (count === 0) return -1;
  if (current < 0) return delta === 1 ? 0 : count - 1;
  return Math.min(count - 1, Math.max(0, current + delta));
};
