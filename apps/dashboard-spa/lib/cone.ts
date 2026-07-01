// Pure geometry for the sign-out "safe cone" — the triangle that bridges the
// rail trigger and its confirm panel. Its apex trails the pointer along the
// pointer's own heading (a pointer delta, not a timeout): heading toward the
// panel keeps the live pointer inside the cone (rail stays hovered → menu
// stays open); a deliberate retreat pushes the apex ahead of the pointer so it
// falls out of the cone and the menu can close. SignOutButton feeds the result
// into CSS custom properties that drive the panel's clip-path pseudo-element.
//
// The heading is derived from a noisy event stream, so it must not trust any
// single event:
// - Sub-floor moves accumulate from a fixed `anchor` instead of advancing it.
//   120Hz devices emit ~1px per event at ordinary speeds; advancing the anchor
//   every event would keep the delta below the floor forever and starve the
//   heading stale.
// - Aligned moves BLEND toward the raw direction, weighted by distance, so
//   small-delta angular noise rotates the cone a little instead of snapping it.
// - Opposed moves (dot < 0) hold the heading until `reverseDelta` px of
//   cumulative opposed travel, then snap. Close-on-reversal therefore fires at
//   any retreat speed, while a backward twitch never flips the cone.

export interface Vec {
  readonly x: number;
  readonly y: number;
}

export interface Heading {
  /** Last pointer position that produced an advance; sub-floor moves accumulate from here. */
  readonly anchor: Vec;
  /** Unit heading the apex trails along. */
  readonly dir: Vec;
  /** Cumulative px of opposed travel since the last aligned advance. */
  readonly reverse: number;
}

/** Fresh heading aimed at the panel (rightward) until the pointer says otherwise. */
export function initialHeading(anchor: Vec, dir: Vec = { x: 1, y: 0 }): Heading {
  return { anchor, dir, reverse: 0 };
}

/**
 * Fold one pointer sample into the heading. `minDelta` is the jitter floor —
 * measured from the anchor, so slow drift accumulates. An aligned move of
 * `blendDelta` px re-aims fully; shorter ones blend proportionally. Opposed
 * travel flips the heading only once `reverseDelta` px accumulate.
 */
export function advanceHeading(
  state: Heading,
  curr: Vec,
  minDelta = 3,
  blendDelta = 16,
  reverseDelta = 12,
): Heading {
  const dx = curr.x - state.anchor.x;
  const dy = curr.y - state.anchor.y;
  const len = Math.hypot(dx, dy);
  if (len < minDelta) return state;
  const raw = { x: dx / len, y: dy / len };
  const dot = state.dir.x * raw.x + state.dir.y * raw.y;
  if (dot < 0) {
    const reverse = state.reverse + len;
    return reverse >= reverseDelta
      ? { anchor: curr, dir: raw, reverse: 0 }
      : { anchor: curr, dir: state.dir, reverse };
  }
  const a = Math.min(1, len / blendDelta);
  const bx = state.dir.x * (1 - a) + raw.x * a;
  const by = state.dir.y * (1 - a) + raw.y * a;
  // dot ≥ 0 bounds |blend| ≥ √0.5, so normalization never degenerates.
  const blen = Math.hypot(bx, by);
  return { anchor: curr, dir: { x: bx / blen, y: by / blen }, reverse: 0 };
}

/**
 * The cone apex: `curr` pushed back along `dir` by `buffer` px. With the apex
 * behind the pointer (relative to its heading) the live pointer sits inside the
 * cone while approaching the panel, and outside it once the heading reverses.
 */
export function coneApex(curr: Vec, dir: Vec, buffer: number): Vec {
  return { x: curr.x - dir.x * buffer, y: curr.y - dir.y * buffer };
}
