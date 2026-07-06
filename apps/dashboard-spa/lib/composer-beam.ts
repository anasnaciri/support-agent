// Decides the composer border beam's state from its three signals. Machine
// work (ticket processing / rephrase in flight) gets the full glow; the
// manager merely typing gets a fainter one so the animation reads as ambient
// feedback, not activity. When inactive the strength is irrelevant (the beam
// is faded out) — it stays at the typing level.
export const FULL_BEAM_STRENGTH = 0.8;
export const TYPING_BEAM_STRENGTH = 0.55;

export interface ComposerBeamSignals {
  readonly processing: boolean;
  readonly rephrasing: boolean;
  readonly typing: boolean;
}

export interface ComposerBeamState {
  readonly active: boolean;
  readonly strength: number;
}

export const composerBeam = ({
  processing,
  rephrasing,
  typing,
}: ComposerBeamSignals): ComposerBeamState => {
  const machineWork = processing || rephrasing;
  return {
    active: machineWork || typing,
    strength: machineWork ? FULL_BEAM_STRENGTH : TYPING_BEAM_STRENGTH,
  };
};
