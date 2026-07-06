import { describe, expect, it } from "vitest";

import {
  DARK_BEAM_STRENGTH,
  FULL_BEAM_STRENGTH,
  LIGHT_BEAM_STRENGTH,
  TYPING_BEAM_STRENGTH,
  composerBeamTheme,
  composerBeam,
} from "../lib/composer-beam";

// The composer's border beam lights for three signals with two intensities:
// full strength while the machine works (ticket processing / rephrase in
// flight), and a fainter glow while the manager is merely typing.
describe("composerBeam", () => {
  it("stays dark when nothing is happening", () => {
    expect(
      composerBeam({ processing: false, rephrasing: false, typing: false })
        .active,
    ).toBe(false);
  });

  it("runs at full strength while the ticket is processing", () => {
    expect(
      composerBeam({
        processing: true,
        rephrasing: false,
        typing: false,
        theme: "light",
        systemPrefersDark: false,
      }),
    ).toEqual({
      active: true,
      strength: FULL_BEAM_STRENGTH,
      theme: "light",
    });
  });

  it("runs at full strength while a rephrase is in flight", () => {
    expect(
      composerBeam({
        processing: false,
        rephrasing: true,
        typing: false,
        theme: "dark",
        systemPrefersDark: true,
      }),
    ).toEqual({
      active: true,
      strength: FULL_BEAM_STRENGTH,
      theme: "dark",
    });
  });

  it("uses the light strength when the manager is only typing in light mode", () => {
    expect(
      composerBeam({
        processing: false,
        rephrasing: false,
        typing: true,
        theme: "light",
        systemPrefersDark: false,
      }),
    ).toEqual({
      active: true,
      strength: LIGHT_BEAM_STRENGTH,
      theme: "light",
    });
  });

  it("uses the dark strength when the manager is only typing in dark mode", () => {
    expect(
      composerBeam({
        processing: false,
        rephrasing: false,
        typing: true,
        theme: "dark",
        systemPrefersDark: false,
      }),
    ).toEqual({
      active: true,
      strength: DARK_BEAM_STRENGTH,
      theme: "dark",
    });
  });

  it("machine work outranks typing — full strength wins", () => {
    expect(
      composerBeam({
        processing: false,
        rephrasing: true,
        typing: true,
        theme: "light",
        systemPrefersDark: false,
      }).strength,
    ).toBe(FULL_BEAM_STRENGTH);
  });

  it("typing is fainter than machine work", () => {
    expect(TYPING_BEAM_STRENGTH).toBeLessThan(FULL_BEAM_STRENGTH);
  });
});

describe("composerBeamTheme", () => {
  it("maps the app's explicit theme values to Beam theme values", () => {
    expect(composerBeamTheme("light")).toBe("light");
    expect(composerBeamTheme("dark")).toBe("dark");
  });

  it("maps the app's system value to Beam auto", () => {
    expect(composerBeamTheme("system")).toBe("auto");
  });

  it("resolves system strength from the OS color scheme", () => {
    expect(
      composerBeam({
        processing: false,
        rephrasing: false,
        typing: true,
        theme: "system",
        systemPrefersDark: true,
      }).strength,
    ).toBe(DARK_BEAM_STRENGTH);

    expect(
      composerBeam({
        processing: false,
        rephrasing: false,
        typing: true,
        theme: "system",
        systemPrefersDark: false,
      }).strength,
    ).toBe(LIGHT_BEAM_STRENGTH);
  });
});
