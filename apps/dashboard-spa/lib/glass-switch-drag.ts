/**
 * Pure drag model for the GlassSwitch thumb.
 *
 * A pointer-down starts a gesture at the slot matching the current checked
 * state. Movement past DRAG_THRESHOLD_PX latches the gesture into a drag (it
 * never un-latches — returning to the start point must not degrade a drag
 * back into a tap). On release, a tap toggles; a drag commits whichever side
 * of the track's midpoint the thumb landed on.
 */

/** Movement (px) at which a press stops being a tap and becomes a drag. */
export const DRAG_THRESHOLD_PX = 3;

/** Has the pointer moved far enough from its start to count as a drag? */
export function isDrag(dx: number): boolean {
  return Math.abs(dx) >= DRAG_THRESHOLD_PX;
}

/** Thumb x (0..travel) for the resting slot of a checked state. */
export function originX(checked: boolean, travel: number): number {
  return checked ? travel : 0;
}

/** Thumb x while dragging: origin + finger delta, clamped to the track. */
export function dragX(origin: number, dx: number, travel: number): number {
  return Math.min(Math.max(origin + dx, 0), travel);
}

/** Checked state to commit when the pointer is released. */
export function settleChecked(gesture: {
  readonly checked: boolean;
  readonly dragged: boolean;
  readonly dx: number;
  readonly travel: number;
}): boolean {
  const { checked, dragged, dx, travel } = gesture;
  if (!dragged) return !checked;
  return dragX(originX(checked, travel), dx, travel) >= travel / 2;
}
