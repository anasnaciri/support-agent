import { describe, expect, it } from "vitest";

import {
  THEME_PREFERENCES,
  THEME_STORAGE_KEY,
  cycleTheme,
  parseThemePreference,
  resolveTheme,
  themeLabel,
  type ThemePreference,
} from "../lib/theme.js";

describe("parseThemePreference", () => {
  it("accepts the three valid preferences", () => {
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("system")).toBe("system");
  });

  it("falls back to system for anything else (missing, legacy, junk)", () => {
    expect(parseThemePreference(null)).toBe("system");
    expect(parseThemePreference("")).toBe("system");
    expect(parseThemePreference("auto")).toBe("system");
    expect(parseThemePreference("DARK")).toBe("system");
  });
});

describe("resolveTheme", () => {
  it("explicit preferences ignore the OS setting", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("system follows the OS setting", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("cycleTheme", () => {
  it("cycles light → dark → system → light", () => {
    expect(cycleTheme("light")).toBe("dark");
    expect(cycleTheme("dark")).toBe("system");
    expect(cycleTheme("system")).toBe("light");
  });

  it("visits every preference exactly once per lap", () => {
    const seen = new Set<string>();
    let pref: ThemePreference = "light";
    for (let i = 0; i < THEME_PREFERENCES.length; i++) {
      seen.add(pref);
      pref = cycleTheme(pref);
    }
    expect(pref).toBe("light");
    expect(seen.size).toBe(THEME_PREFERENCES.length);
  });
});

describe("themeLabel", () => {
  it("names each preference for titles/aria", () => {
    expect(themeLabel("light")).toBe("Light");
    expect(themeLabel("dark")).toBe("Dark");
    expect(themeLabel("system")).toBe("System");
  });
});

describe("storage key", () => {
  // The index.html no-flash boot script reads this exact key before the
  // bundle loads; if the constant drifts, the first paint uses the wrong
  // theme. Pin it.
  it("is the literal the inline boot script reads", () => {
    expect(THEME_STORAGE_KEY).toBe("theme");
  });
});
