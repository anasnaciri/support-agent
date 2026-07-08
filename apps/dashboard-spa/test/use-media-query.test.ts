import { describe, expect, it } from "vitest";

import {
  MOBILE_BREAKPOINT_PX,
  MOBILE_BREAKPOINT_QUERY,
} from "../lib/use-media-query.js";

// The shell's mobile/desktop split must track Tailwind's `md` breakpoint
// (48rem = 768px): the rail hides and the drawers take over strictly below
// it, so the query matches up to 767px and md: styles from 768px — no gap,
// no overlap.
describe("mobile breakpoint", () => {
  it("pins the px value to Tailwind md", () => {
    expect(MOBILE_BREAKPOINT_PX).toBe(768);
  });

  it("matches strictly below the breakpoint", () => {
    expect(MOBILE_BREAKPOINT_QUERY).toBe("(max-width: 767px)");
  });
});
