import { resolveTheme, type ThemePreference } from "./theme";

export type ComposerBeamTheme = "dark" | "light" | "auto";

// Decides the composer border beam's state from its three signals. Machine
// work (ticket processing / rephrase in flight) gets the full glow; the
// manager merely typing gets a theme-tuned glow so light mode stays visible
// without making dark mode too loud. When inactive the strength is irrelevant
// (the beam is faded out) — it stays at the current theme's typing level.
export const FULL_BEAM_STRENGTH = 0.8;
export const DARK_BEAM_STRENGTH = 0.45;
export const LIGHT_BEAM_STRENGTH = 0.7;
export const TYPING_BEAM_STRENGTH = DARK_BEAM_STRENGTH;

export interface ComposerBeamSignals {
  readonly processing: boolean;
  readonly rephrasing: boolean;
  readonly typing: boolean;
  readonly theme?: ThemePreference;
  readonly systemPrefersDark?: boolean;
}

export interface ComposerBeamState {
  readonly active: boolean;
  readonly strength: number;
  readonly theme: ComposerBeamTheme;
}

export const composerBeamTheme = (
  preference: ThemePreference,
): ComposerBeamTheme => (preference === "system" ? "auto" : preference);

const themeStrength = (
  preference: ThemePreference,
  systemPrefersDark: boolean,
): number =>
  resolveTheme(preference, systemPrefersDark) === "dark"
    ? DARK_BEAM_STRENGTH
    : LIGHT_BEAM_STRENGTH;

export const composerBeam = ({
  processing,
  rephrasing,
  typing,
  theme = "system",
  systemPrefersDark = false,
}: ComposerBeamSignals): ComposerBeamState => {
  const machineWork = processing || rephrasing;
  return {
    active: machineWork || typing,
    strength: machineWork
      ? FULL_BEAM_STRENGTH
      : themeStrength(theme, systemPrefersDark),
    theme: composerBeamTheme(theme),
  };
};
