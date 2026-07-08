import { Monitor, Moon, Sun } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  THEME_PREFERENCES,
  cycleTheme,
  themeLabel,
  type ThemePreference,
} from "@/lib/theme";
import { setThemePreference, useThemePreference } from "@/lib/theme-store";

const ICONS: Record<ThemePreference, LucideIcon> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};

/**
 * Theme switch as a rail row. Collapsed, it's a single icon button that
 * cycles light → dark → system (the only affordance that fits 40px).
 * Expanded, a segmented Light/Dark/System control fades in where the other
 * rows show their label. `overflow-hidden` clips the segments while the rail
 * is narrow — same trick the labels play with `truncate`.
 *
 * `expanded` (the mobile nav drawer) skips the hover reveal: the segments are
 * always visible because there is no hover on touch.
 */
export function ThemeSwitch({ expanded = false }: { readonly expanded?: boolean }) {
  const preference = useThemePreference();
  const Icon = ICONS[preference];

  return (
    <div className="flex h-10 w-full items-center gap-3">
      <button
        type="button"
        title={`Theme: ${themeLabel(preference)} — click to switch`}
        aria-label={`Theme: ${themeLabel(preference)} — click to switch`}
        onClick={() => setThemePreference(cycleTheme(preference))}
        className="flex size-10 shrink-0 items-center justify-center rounded-lg text-sidebar-foreground/55 transition-colors hover:bg-white/5 hover:text-sidebar-foreground"
      >
        <Icon className="size-5" aria-hidden />
      </button>
      <div
        role="group"
        aria-label="Theme"
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1 overflow-hidden",
          expanded
            ? "opacity-100"
            : "opacity-0 transition-opacity duration-200 group-hover/rail:opacity-100",
        )}
      >
        {THEME_PREFERENCES.map((option) => {
          const OptionIcon = ICONS[option];
          const active = option === preference;
          return (
            <button
              key={option}
              type="button"
              title={themeLabel(option)}
              aria-label={`${themeLabel(option)} theme`}
              aria-pressed={active}
              onClick={() => setThemePreference(option)}
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-md transition-colors",
                active
                  ? "bg-white/10 text-sidebar-foreground"
                  : "text-sidebar-foreground/55 hover:bg-white/5 hover:text-sidebar-foreground",
              )}
            >
              <OptionIcon className="size-4" aria-hidden />
            </button>
          );
        })}
      </div>
    </div>
  );
}
