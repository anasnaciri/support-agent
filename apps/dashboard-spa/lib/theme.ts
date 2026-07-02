/**
 * Theme preference logic, pure so it's testable under node. The DOM side —
 * localStorage, matchMedia, the `.dark` class on <html> — lives in
 * `theme-store.ts`, and a tiny inline script in index.html applies the stored
 * preference before first paint (it must keep reading THEME_STORAGE_KEY).
 */
export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "theme";

/** Cycle order for the collapsed-rail button; also the segmented-control order. */
export const THEME_PREFERENCES: ReadonlyArray<ThemePreference> = [
  "light",
  "dark",
  "system",
];

/** Anything unrecognized (missing key, junk, legacy value) → follow the OS. */
export const parseThemePreference = (raw: string | null): ThemePreference =>
  raw === "light" || raw === "dark" ? raw : "system";

export const resolveTheme = (
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme =>
  preference === "system" ? (systemPrefersDark ? "dark" : "light") : preference;

export const cycleTheme = (preference: ThemePreference): ThemePreference =>
  preference === "light" ? "dark" : preference === "dark" ? "system" : "light";

export const themeLabel = (preference: ThemePreference): string =>
  preference === "system"
    ? "System"
    : preference === "dark"
      ? "Dark"
      : "Light";
