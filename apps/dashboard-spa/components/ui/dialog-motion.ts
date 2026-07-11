/**
 * Shared enter/exit motion for modal surfaces.
 *
 * The dialog is centred with `translate` (a Tailwind v4 property utility), not
 * with `transform` — so the keyframes below are free to own `transform`
 * outright. That is why nothing here slides in from the left or the top:
 * shadcn's v3-era template pairs a half-width left slide with a 48% top slide
 * to re-apply the centring translate from inside the keyframe, and carrying
 * that pair over to v4 only drags the dialog in diagonally from the top-left.
 *
 * Entry is slower than exit (200ms vs 150ms) and eased out rather than in: a
 * dialog should arrive gently and get out of the way briskly.
 */

export const DIALOG_OVERLAY_MOTION = [
  "data-[state=open]:animate-in data-[state=open]:fade-in-0",
  "data-[state=open]:duration-200 data-[state=open]:ease-out",
  "data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
  "data-[state=closed]:duration-150 data-[state=closed]:ease-in",
].join(" ");

/**
 * Fade + scale from the centre. On a phone, where the dialog is thumb-distance
 * from the bottom of the screen, it also rises from below on entry and drops
 * back down on exit; from `sm` up there is no vertical travel at all.
 */
export const DIALOG_CONTENT_MOTION = [
  "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
  "data-[state=open]:slide-in-from-bottom-6 sm:data-[state=open]:slide-in-from-bottom-0",
  "data-[state=open]:duration-200 data-[state=open]:ease-out",
  "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
  "data-[state=closed]:slide-out-to-bottom-6 sm:data-[state=closed]:slide-out-to-bottom-0",
  "data-[state=closed]:duration-150 data-[state=closed]:ease-in",
].join(" ");
