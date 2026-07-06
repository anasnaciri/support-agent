import { describe, expect, it } from "vitest";

import {
  FULL_BEAM_STRENGTH,
  TYPING_BEAM_STRENGTH,
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
      composerBeam({ processing: true, rephrasing: false, typing: false }),
    ).toEqual({ active: true, strength: FULL_BEAM_STRENGTH });
  });

  it("runs at full strength while a rephrase is in flight", () => {
    expect(
      composerBeam({ processing: false, rephrasing: true, typing: false }),
    ).toEqual({ active: true, strength: FULL_BEAM_STRENGTH });
  });

  it("glows fainter when the manager is only typing", () => {
    expect(
      composerBeam({ processing: false, rephrasing: false, typing: true }),
    ).toEqual({ active: true, strength: TYPING_BEAM_STRENGTH });
  });

  it("machine work outranks typing — full strength wins", () => {
    expect(
      composerBeam({ processing: false, rephrasing: true, typing: true })
        .strength,
    ).toBe(FULL_BEAM_STRENGTH);
  });

  it("typing is fainter than machine work", () => {
    expect(TYPING_BEAM_STRENGTH).toBeLessThan(FULL_BEAM_STRENGTH);
  });
});
