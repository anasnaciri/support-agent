import { describe, expect, it } from "vitest";

import {
  DRAG_THRESHOLD_PX,
  dragX,
  isDrag,
  originX,
  settleChecked,
} from "../lib/glass-switch-drag";

// The glass switch thumb is draggable: a press-and-move slides the thumb with
// the finger, and release commits whichever side of the track's midpoint the
// thumb landed on. A press-and-release without meaningful movement is a tap
// and simply toggles. "Was this a drag?" latches the moment movement ever
// exceeds the threshold — returning to the start point must NOT turn a drag
// back into a tap, or a cancelled drag would toggle the switch.
const TRAVEL = 20;

describe("isDrag", () => {
  it("treats sub-threshold jitter as a tap", () => {
    expect(isDrag(0)).toBe(false);
    expect(isDrag(DRAG_THRESHOLD_PX - 1)).toBe(false);
    expect(isDrag(-(DRAG_THRESHOLD_PX - 1))).toBe(false);
  });

  it("latches into a drag at the threshold, either direction", () => {
    expect(isDrag(DRAG_THRESHOLD_PX)).toBe(true);
    expect(isDrag(-DRAG_THRESHOLD_PX)).toBe(true);
  });
});

describe("originX", () => {
  it("starts the thumb at the slot matching the checked state", () => {
    expect(originX(false, TRAVEL)).toBe(0);
    expect(originX(true, TRAVEL)).toBe(TRAVEL);
  });
});

describe("dragX", () => {
  it("follows the finger within the track", () => {
    expect(dragX(0, 7, TRAVEL)).toBe(7);
    expect(dragX(TRAVEL, -12, TRAVEL)).toBe(8);
  });

  it("clamps to the track ends", () => {
    expect(dragX(0, 999, TRAVEL)).toBe(TRAVEL);
    expect(dragX(0, -999, TRAVEL)).toBe(0);
    expect(dragX(TRAVEL, 999, TRAVEL)).toBe(TRAVEL);
  });
});

describe("settleChecked", () => {
  it("toggles on a tap", () => {
    expect(
      settleChecked({ checked: false, dragged: false, dx: 1, travel: TRAVEL }),
    ).toBe(true);
    expect(
      settleChecked({ checked: true, dragged: false, dx: -1, travel: TRAVEL }),
    ).toBe(false);
  });

  it("commits a drag that crosses the midpoint", () => {
    expect(
      settleChecked({ checked: false, dragged: true, dx: 15, travel: TRAVEL }),
    ).toBe(true);
    expect(
      settleChecked({ checked: true, dragged: true, dx: -15, travel: TRAVEL }),
    ).toBe(false);
  });

  it("snaps back when the drag ends short of the midpoint", () => {
    expect(
      settleChecked({ checked: false, dragged: true, dx: 6, travel: TRAVEL }),
    ).toBe(false);
    expect(
      settleChecked({ checked: true, dragged: true, dx: -6, travel: TRAVEL }),
    ).toBe(true);
  });

  it("landing exactly on the midpoint reads as on", () => {
    expect(
      settleChecked({
        checked: false,
        dragged: true,
        dx: TRAVEL / 2,
        travel: TRAVEL,
      }),
    ).toBe(true);
  });

  it("a drag returned to its start point stays put — it is not a tap", () => {
    expect(
      settleChecked({ checked: false, dragged: true, dx: 1, travel: TRAVEL }),
    ).toBe(false);
    expect(
      settleChecked({ checked: true, dragged: true, dx: -1, travel: TRAVEL }),
    ).toBe(true);
  });

  it("overshooting past the far end still commits", () => {
    expect(
      settleChecked({ checked: false, dragged: true, dx: 999, travel: TRAVEL }),
    ).toBe(true);
  });
});
