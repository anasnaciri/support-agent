import { describe, expect, it } from "vitest";

import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  parseSidebarWidth,
} from "../lib/sidebar-width.js";

describe("clampSidebarWidth", () => {
  it("keeps an in-range width (rounded to a whole pixel)", () => {
    expect(clampSidebarWidth(320)).toBe(320);
    expect(clampSidebarWidth(300.6)).toBe(301);
  });

  it("clamps below the minimum up", () => {
    expect(clampSidebarWidth(50)).toBe(SIDEBAR_MIN_WIDTH);
  });

  it("clamps above the maximum down", () => {
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX_WIDTH);
  });
});

describe("parseSidebarWidth", () => {
  it("falls back to the default for a missing or bad cookie", () => {
    expect(parseSidebarWidth(undefined)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(parseSidebarWidth("")).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(parseSidebarWidth("wide")).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it("parses and clamps a stored width", () => {
    expect(parseSidebarWidth("320")).toBe(320);
    expect(parseSidebarWidth("100")).toBe(SIDEBAR_MIN_WIDTH);
    expect(parseSidebarWidth("9999")).toBe(SIDEBAR_MAX_WIDTH);
  });
});
