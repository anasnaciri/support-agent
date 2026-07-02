import { useSyncExternalStore } from "react";

import {
  THEME_STORAGE_KEY,
  parseThemePreference,
  resolveTheme,
  type ThemePreference,
} from "./theme";

/**
 * The DOM half of theming: owns the stored preference, keeps the `.dark`
 * class on <html> in sync, and re-applies when the OS scheme changes while
 * the preference is "system". Browser-only — the pure logic it defers to is
 * in `theme.ts` (tested under node). First paint is handled even earlier by
 * the inline boot script in index.html, so applying here is idempotent.
 */
const media = window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

const readStored = (): ThemePreference => {
  try {
    return parseThemePreference(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
};

let preference: ThemePreference = readStored();

const apply = (): void => {
  document.documentElement.classList.toggle(
    "dark",
    resolveTheme(preference, media.matches) === "dark",
  );
};

const notify = (): void => {
  for (const listener of listeners) listener();
};

export const getThemePreference = (): ThemePreference => preference;

export const setThemePreference = (next: ThemePreference): void => {
  preference = next;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // Private mode / blocked storage: the choice still applies this visit.
  }
  apply();
  notify();
};

export const subscribeTheme = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

media.addEventListener("change", () => {
  if (preference === "system") apply();
});

// Another tab changing the preference should not leave this one stale.
window.addEventListener("storage", (e) => {
  if (e.key !== THEME_STORAGE_KEY) return;
  preference = readStored();
  apply();
  notify();
});

apply();

export const useThemePreference = (): ThemePreference =>
  useSyncExternalStore(subscribeTheme, getThemePreference);
