import { describe, expect, it } from "vitest";

import {
  advanceHeading,
  coneApex,
  initialHeading,
  type Heading,
} from "../lib/cone";

// The sign-out confirm bridges the rail and its panel with a "safe cone" whose
// apex trails the pointer along its heading. These pure helpers compute that
// heading and the trailing apex; the component just feeds them into CSS custom
// properties on the panel.
//
// The heading must survive two real-world pointer-stream conditions:
// - 120Hz devices emit ~1px per event at ordinary speeds, so sub-floor moves
//   must ACCUMULATE from a fixed anchor (never advance it), or the heading
//   starves and stays stale forever.
// - Per-event direction at small deltas is angularly noisy, so an advance must
//   BLEND toward the raw direction (weighted by distance), not replace it —
//   and a backward twitch must not flip the cone until the retreat is
//   deliberate (cumulative opposed travel), at which point it must flip at any
//   speed so close-on-reversal still works.

describe("initialHeading", () => {
  it("anchors at the given point, aims at the panel, no reversal credit", () => {
    expect(initialHeading({ x: 5, y: 7 })).toEqual({
      anchor: { x: 5, y: 7 },
      dir: { x: 1, y: 0 },
      reverse: 0,
    });
  });
});

describe("advanceHeading", () => {
  const start = (anchor = { x: 0, y: 0 }): Heading => initialHeading(anchor);

  it("returns the state unchanged — anchor included — for a sub-floor move", () => {
    // Advancing the anchor on sub-floor moves is the starvation bug: at 1px
    // per event the delta would never accumulate past the floor.
    const state = start();
    expect(advanceHeading(state, { x: 1.5, y: 0 })).toBe(state);
  });

  it("accumulates slow drift across events until it clears the floor", () => {
    // Successive 1px rightward samples: the anchor stays at 0, so the third
    // sample's cumulative 3px clears the floor even though no single event did.
    let state: Heading = { anchor: { x: 0, y: 0 }, dir: { x: 0, y: 1 }, reverse: 0 };
    state = advanceHeading(state, { x: 1, y: 0 });
    state = advanceHeading(state, { x: 2, y: 0 });
    expect(state.dir).toEqual({ x: 0, y: 1 }); // still below the floor
    state = advanceHeading(state, { x: 3, y: 0 });
    expect(state.anchor).toEqual({ x: 3, y: 0 });
    expect(state.dir.x).toBeGreaterThan(0); // rotated toward the drift
  });

  it("advances on a move of exactly the floor", () => {
    const next = advanceHeading(start(), { x: 3, y: 0 });
    expect(next.anchor).toEqual({ x: 3, y: 0 });
  });

  it("partially re-aims on a short aligned move", () => {
    // 8px perpendicular move = half blendDelta → halfway between old and raw.
    const next = advanceHeading(start(), { x: 0, y: 8 });
    expect(next.dir.x).toBeCloseTo(Math.SQRT1_2);
    expect(next.dir.y).toBeCloseTo(Math.SQRT1_2);
    expect(next.reverse).toBe(0);
  });

  it("re-aims fully on a single fast move", () => {
    const next = advanceHeading(start(), { x: 0, y: 16 });
    expect(next.dir.x).toBeCloseTo(0);
    expect(next.dir.y).toBeCloseTo(1);
  });

  it("always returns a unit heading", () => {
    const next = advanceHeading(start(), { x: 6, y: 6 });
    expect(Math.hypot(next.dir.x, next.dir.y)).toBeCloseTo(1);
  });

  it("keeps an unchanged direction when the move is dead ahead", () => {
    const next = advanceHeading(start(), { x: 10, y: 0 });
    expect(next.dir.x).toBeCloseTo(1);
    expect(next.dir.y).toBeCloseTo(0);
  });

  it("holds the heading on a small backward twitch (cone must not flip)", () => {
    const next = advanceHeading(start(), { x: -3, y: 0 });
    expect(next.dir).toEqual({ x: 1, y: 0 });
    expect(next.reverse).toBe(3);
    // The apex therefore stays behind the pointer — still a safe bridge.
    expect(coneApex({ x: 100, y: 50 }, next.dir, 48)).toEqual({ x: 52, y: 50 });
  });

  it("flips only once opposed travel accumulates past the threshold", () => {
    let state = advanceHeading(start(), { x: -4, y: 0 });
    expect(state.dir).toEqual({ x: 1, y: 0 });
    expect(state.reverse).toBe(4);
    state = advanceHeading(state, { x: -8, y: 0 });
    expect(state.dir).toEqual({ x: 1, y: 0 });
    expect(state.reverse).toBe(8);
    state = advanceHeading(state, { x: -12, y: 0 });
    expect(state.dir).toEqual({ x: -1, y: 0 }); // 12px cumulative ≥ threshold
    expect(state.reverse).toBe(0);
  });

  it("flips immediately on a single deliberate backward move", () => {
    const next = advanceHeading(start(), { x: -16, y: 0 });
    expect(next.dir).toEqual({ x: -1, y: 0 });
    expect(next.reverse).toBe(0);
  });

  it("resets reversal credit on an aligned advance, so wobble never flips", () => {
    let state = advanceHeading(start(), { x: -8, y: 0 });
    expect(state.reverse).toBe(8);
    state = advanceHeading(state, { x: 0, y: 0 }); // 8px back toward the panel
    expect(state.reverse).toBe(0);
    state = advanceHeading(state, { x: -8, y: 0 }); // wobble again
    expect(state.dir.x).toBeGreaterThan(0); // still aimed at the panel
  });

  it("flips on a slow deliberate retreat (accumulated, not per-event)", () => {
    // 3px-per-advance leftward — the speed at which a pure LERP would never
    // flip. Must close-on-reversal once 12px have accumulated.
    let state = start();
    let x = 0;
    for (let i = 0; i < 4; i++) {
      x -= 3;
      state = advanceHeading(state, { x, y: 0 });
    }
    expect(state.dir).toEqual({ x: -1, y: 0 });
  });
});

describe("coneApex", () => {
  it("pushes the apex back along the heading so the live pointer sits inside", () => {
    // Heading right toward the panel → apex is `buffer` px to the left.
    expect(coneApex({ x: 100, y: 50 }, { x: 1, y: 0 }, 40)).toEqual({
      x: 60,
      y: 50,
    });
  });

  it("flips the apex ahead of the pointer when the heading reverses", () => {
    // Heading away (left) → apex is pushed right (toward the panel), leaving the
    // pointer outside the cone so the menu can close.
    expect(coneApex({ x: 100, y: 50 }, { x: -1, y: 0 }, 40)).toEqual({
      x: 140,
      y: 50,
    });
  });
});
