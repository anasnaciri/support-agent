import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * GlassSwitch — an on/off switch with a "liquid glass" thumb.
 *
 * The thumb is a lens: it shows a refracted copy of the track underneath,
 * bent through an SVG `feDisplacementMap` whose displacement map is generated
 * at runtime on a canvas from the lens geometry (rounded-rect SDF → outward
 * bend near the bezel, neutral in the middle). Three displacement passes at
 * slightly different strengths are recombined per RGB channel for a faint
 * chromatic fringe, and CSS gradient/inset-shadow layers add the specular
 * highlight and rim light. If the filter (or canvas) is unavailable the lens
 * copy aligns exactly with the real track, so the switch degrades to a clean
 * translucent thumb — nothing breaks.
 *
 * It wraps a real `<input type="checkbox" role="switch">` (visually hidden),
 * so it works uncontrolled inside forms (`name` + `defaultChecked`, submits
 * "on" via FormData) and controlled (`checked` + `onChange`) alike. All
 * visual state is driven by `:has(:checked)` — no JS state.
 *
 * GEOMETRY SYNC: the Tailwind arbitrary values below (`--x:20px`,
 * `--px:-20px`) must equal TRAVEL; Tailwind needs the literals to be static.
 */

// Track / thumb geometry (CSS px). TRAVEL = TRACK_W - THUMB_W - 2 * INSET.
const TRACK_W = 64;
const TRACK_H = 28;
const THUMB_W = 38;
const THUMB_H = 22;
const INSET = 3;
const TRAVEL = TRACK_W - THUMB_W - 2 * INSET; // 20 — keep class literals in sync
// The filtered lens bleeds past the thumb so displaced pixels near the edge
// sample real (opaque) content instead of transparency. Must exceed the max
// displacement (SCALE / 2).
const BLEED = 12;
const LENS_W = THUMB_W + 2 * BLEED;
const LENS_H = THUMB_H + 2 * BLEED;
// Bezel depth of the lens profile and feDisplacementMap scale (max shift =
// SCALE / 2 px, which must stay under BLEED).
const DEPTH = 7;
const SCALE = 16;
// Map canvas is rendered at 2x and downsampled by feImage for smoother ramps.
const MAP_DPR = 2;

/** Signed distance from `(px, py)` to a rounded box centred at the origin. */
function sdRoundedBox(
  px: number,
  py: number,
  bx: number,
  by: number,
  r: number,
): number {
  const qx = Math.abs(px) - bx + r;
  const qy = Math.abs(py) - by + r;
  return (
    Math.min(Math.max(qx, qy), 0) +
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) -
    r
  );
}

let cachedMapUrl: string | null = null;

/**
 * Draw the displacement map for the lens: R/G encode the x/y bend (128 =
 * neutral), strongest at the lens edge and easing to zero DEPTH px inward,
 * pointing along the outward surface normal so edge pixels sample outward
 * (a magnifying lens). Returns "" when canvas 2D is unavailable (jsdom).
 */
function lensMapUrl(): string {
  if (cachedMapUrl !== null) return cachedMapUrl;
  const w = LENS_W * MAP_DPR;
  const h = LENS_H * MAP_DPR;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    cachedMapUrl = "";
    return cachedMapUrl;
  }

  const img = ctx.createImageData(w, h);
  const cx = w / 2;
  const cy = h / 2;
  const bx = (THUMB_W / 2) * MAP_DPR;
  const by = (THUMB_H / 2) * MAP_DPR;
  const r = by; // fully-rounded pill
  const depth = DEPTH * MAP_DPR;
  const sd = (x: number, y: number) => sdRoundedBox(x - cx, y - cy, bx, by, r);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let dx = 0;
      let dy = 0;
      const d = sd(x + 0.5, y + 0.5);
      if (d < 0) {
        // Inside the lens: u = 0 at the edge → 1 at the bezel's inner end.
        const u = Math.min(-d / depth, 1);
        // Circular bezel profile — full bend at the edge, easing inward.
        const strength = Math.sqrt(Math.max(1 - u * u, 0));
        if (strength > 0) {
          // Outward normal via central differences of the SDF.
          const nx = sd(x + 1, y + 0.5) - sd(x, y + 0.5);
          const ny = sd(x + 0.5, y + 1) - sd(x + 0.5, y);
          const len = Math.hypot(nx, ny) || 1;
          dx = (nx / len) * strength;
          dy = (ny / len) * strength;
        }
      }
      img.data[i] = Math.round(128 + dx * 127);
      img.data[i + 1] = Math.round(128 + dy * 127);
      img.data[i + 2] = 128;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  cachedMapUrl = canvas.toDataURL("image/png");
  return cachedMapUrl;
}

// Shared spring-ish motion for the thumb and the counter-moving track copy —
// identical curves so the refracted track appears stationary mid-flight.
const MOTION =
  "duration-300 ease-[cubic-bezier(0.34,1.25,0.64,1)] motion-reduce:transition-none";

export type GlassSwitchProps = React.InputHTMLAttributes<HTMLInputElement>;

export function GlassSwitch({ className, ...props }: GlassSwitchProps) {
  const filterId = React.useId();
  const [map, setMap] = React.useState<string>("");
  React.useEffect(() => {
    setMap(lensMapUrl());
  }, []);

  return (
    <span
      className={cn(
        "group/gsw relative inline-block shrink-0 select-none",
        "has-[:disabled]:opacity-50",
        className,
      )}
      style={{ width: TRACK_W, height: TRACK_H }}
    >
      <input type="checkbox" role="switch" className="sr-only" {...props} />

      {/* Track */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-0 rounded-full bg-input transition-colors",
          "shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06),inset_0_1.5px_3px_rgba(0,0,0,0.10)]",
          "group-has-[:checked]/gsw:bg-primary",
          "group-has-[:focus-visible]/gsw:ring-2 group-has-[:focus-visible]/gsw:ring-ring group-has-[:focus-visible]/gsw:ring-offset-2 group-has-[:focus-visible]/gsw:ring-offset-background",
          MOTION,
        )}
      />

      {/* Thumb — a clipped glass lens that slides across the track. */}
      <span
        aria-hidden
        className={cn(
          "absolute overflow-hidden rounded-full transition-transform",
          "shadow-[0_2px_5px_rgba(0,0,0,0.22),0_1px_1.5px_rgba(0,0,0,0.14)]",
          "[--sx:1] [--sy:1] [--x:0px]",
          "group-has-[:checked]/gsw:[--x:20px]",
          "group-active/gsw:[--sx:1.06] group-active/gsw:[--sy:0.94] group-has-[:disabled]/gsw:[--sx:1] group-has-[:disabled]/gsw:[--sy:1]",
          MOTION,
        )}
        style={{
          left: INSET,
          top: INSET,
          width: THUMB_W,
          height: THUMB_H,
          transform: "translateX(var(--x)) scaleX(var(--sx)) scaleY(var(--sy))",
        }}
      >
        {/* Refraction layer: an opaque copy of the local scene (surface +
            track pill), counter-translated so it lines up with the real
            track, then bent by the displacement filter. */}
        <span
          className="absolute bg-card"
          style={{
            left: -BLEED,
            top: -BLEED,
            width: LENS_W,
            height: LENS_H,
            filter: map ? `url(#${filterId})` : undefined,
          }}
        >
          <span
            className={cn(
              "absolute rounded-full bg-input transition-[background-color,transform]",
              "[--px:0px] group-has-[:checked]/gsw:[--px:-20px] group-has-[:checked]/gsw:bg-primary",
              MOTION,
            )}
            style={{
              left: BLEED - INSET,
              top: BLEED - INSET,
              width: TRACK_W,
              height: TRACK_H,
              transform: "translateX(var(--px))",
            }}
          />
        </span>

        {/* Glass tint */}
        <span className="absolute inset-0 rounded-full bg-white/10" />

        {/* Specular highlight + rim light */}
        <span
          className={cn(
            "absolute inset-0 rounded-full",
            "bg-[linear-gradient(160deg,rgba(255,255,255,0.38),rgba(255,255,255,0)_42%)]",
            "shadow-[inset_0_1px_1px_rgba(255,255,255,0.65),inset_0_-1px_2px_rgba(255,255,255,0.18),inset_1px_0_1px_rgba(255,255,255,0.16),inset_-1px_0_1px_rgba(255,255,255,0.16),inset_0_-2px_4px_rgba(0,0,0,0.08)]",
          )}
        />
      </span>

      {/* Displacement filter: three passes at slightly different strengths,
          recombined per RGB channel for a faint chromatic fringe. */}
      {map ? (
        <svg width="0" height="0" aria-hidden className="absolute">
          <filter
            id={filterId}
            filterUnits="userSpaceOnUse"
            x="0"
            y="0"
            width={LENS_W}
            height={LENS_H}
            colorInterpolationFilters="sRGB"
          >
            <feImage
              href={map}
              x="0"
              y="0"
              width={LENS_W}
              height={LENS_H}
              preserveAspectRatio="none"
              result="map"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="map"
              scale={SCALE}
              xChannelSelector="R"
              yChannelSelector="G"
            />
            <feColorMatrix
              type="matrix"
              values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"
              result="dispR"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="map"
              scale={SCALE * 0.92}
              xChannelSelector="R"
              yChannelSelector="G"
            />
            <feColorMatrix
              type="matrix"
              values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0"
              result="dispG"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="map"
              scale={SCALE * 0.84}
              xChannelSelector="R"
              yChannelSelector="G"
            />
            <feColorMatrix
              type="matrix"
              values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0"
              result="dispB"
            />
            <feComposite
              in="dispR"
              in2="dispG"
              operator="arithmetic"
              k1="0"
              k2="1"
              k3="1"
              k4="0"
            />
            <feComposite
              in2="dispB"
              operator="arithmetic"
              k1="0"
              k2="1"
              k3="1"
              k4="0"
            />
          </filter>
        </svg>
      ) : null}
    </span>
  );
}

// Referenced by the geometry-sync comment above; exporting keeps the constant
// honest if a future size variant needs it.
export const GLASS_SWITCH_TRAVEL = TRAVEL;
