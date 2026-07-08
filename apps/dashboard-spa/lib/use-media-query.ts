import { useSyncExternalStore } from "react";

/**
 * Viewport breakpoint hooks for the shell's mobile/desktop split.
 *
 * The constants are the tested contract: the split tracks Tailwind's `md`
 * breakpoint (768px), with the query matching strictly below it so `md:`
 * utilities and `useIsMobile()` never disagree. No top-level `window`
 * access — matchMedia is only touched inside the hook, keeping this module
 * importable under node for tests.
 */
export const MOBILE_BREAKPOINT_PX = 768;
export const MOBILE_BREAKPOINT_QUERY = `(max-width: ${MOBILE_BREAKPOINT_PX - 1}px)`;

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
  );
}

/** True strictly below Tailwind `md` — the shell renders drawers, not rails. */
export const useIsMobile = (): boolean =>
  useMediaQuery(MOBILE_BREAKPOINT_QUERY);
