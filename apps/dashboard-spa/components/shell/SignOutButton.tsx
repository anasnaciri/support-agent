
import { useEffect, useRef } from "react";
import { LogOut } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  advanceHeading,
  coneApex,
  initialHeading,
  type Heading,
  type Vec,
} from "@/lib/cone";
import { logout } from "@/lib/auth/session-api";

// Must match .signout-cone::before in globals.css. REACH/OVERHANG map the
// pointer into the pseudo-element's own box; BUFFER is how far behind the
// pointer the apex trails (the grace area).
const CONE_REACH = 60;
const CONE_OVERHANG = 16;
const CONE_BUFFER = 48;

interface Props {
  readonly email: string | null;
  /** Rail label class so the trigger matches the other rail rows on hover. */
  readonly labelClassName: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /**
   * Where the confirmation opens. "right" (default) suits the hover rail and
   * brings the safe-cone bridge; "above" suits the mobile nav drawer, where
   * the rail's right edge is the drawer's edge and there is no hover to
   * bridge.
   */
  readonly placement?: "right" | "above";
}

/**
 * Two-step sign-out: the rail icon opens a confirmation popover, and only the
 * explicit "Sign out" button inside it submits the server action — so a stray
 * click on the rail never logs you out.
 *
 * The popover spans to the right of the row in the rail's own palette and is a
 * DOM descendant of the rail, so hovering it (or its safe cone) keeps the rail
 * expanded. `open` is owned by the rail, which clears it on mouse-leave so the
 * confirmation hides together with the collapsing rail. A clip-path cone — a
 * pseudo-element on the panel whose apex trails the pointer's heading (pointer
 * delta, no timeout) — bridges the gap so imperfect diagonal movement from the
 * row to the panel doesn't drop the hover.
 */
export function SignOutButton({
  email,
  labelClassName,
  open,
  onOpenChange,
  placement = "right",
}: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Anchor + smoothed unit heading + reversal credit; null until the first
  // move after opening (initialHeading aims at the panel by default).
  const heading = useRef<Heading | null>(null);

  // Close on outside click / Escape, like a native menu.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onOpenChange(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onOpenChange]);

  // Steer the cone from the live pointer. The apex trails the heading so the
  // pointer sits inside the cone while approaching the panel and falls out
  // once it deliberately turns away — then the rail's mouse-leave closes the
  // menu. Written straight to CSS custom properties (no React re-render per
  // move). Only the hover rail ("right") needs the bridge.
  useEffect(() => {
    if (!open || placement !== "right") {
      heading.current = null;
      return;
    }
    const onMove = (e: PointerEvent) => {
      const panel = panelRef.current;
      if (!panel) return;
      const curr: Vec = { x: e.clientX, y: e.clientY };
      heading.current = heading.current
        ? advanceHeading(heading.current, curr)
        : initialHeading(curr);
      const apex = coneApex(curr, heading.current.dir, CONE_BUFFER);
      // Read the rect per move on purpose: the panel slides with the rail's
      // 200ms width transition. (It's the border box, 1px off the pseudo's
      // padding-box offsets — noise against the 48px buffer.)
      const rect = panel.getBoundingClientRect();
      panel.style.setProperty("--cone-x", `${apex.x - (rect.left - CONE_REACH)}px`);
      panel.style.setProperty(
        "--cone-y",
        `${apex.y - (rect.top - CONE_OVERHANG)}px`,
      );
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [open, placement]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        title={email ? `Sign out (${email})` : "Sign out"}
        aria-label="Sign out"
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          // text-left: a <button> defaults to centered text, which would
          // misalign this label against the <a>-based rail rows above it.
          "flex h-10 w-full items-center gap-3 rounded-lg text-left transition-colors",
          open
            ? "bg-white/10 text-sidebar-foreground"
            : "text-sidebar-foreground/55 hover:bg-white/5 hover:text-sidebar-foreground",
        )}
      >
        <span className="flex size-10 shrink-0 items-center justify-center">
          <LogOut className="size-5" aria-hidden />
        </span>
        <span className={labelClassName}>Sign out</span>
      </button>

      {open ? (
        // `signout-cone` clips the bridging safe-cone pseudo-element off this
        // panel's left edge. ml-5 leaves a small gap from the rail that the
        // cone spans; the panel and its cone are rail descendants, so hovering
        // either keeps the rail open.
        <div
          ref={panelRef}
          role="menu"
          aria-label="Confirm sign out"
          className={cn(
            "absolute z-50 w-56 rounded-lg border border-white/10 bg-sidebar p-3 text-sidebar-foreground shadow-xl shadow-black/30",
            placement === "right"
              ? "signout-cone bottom-0 left-full ml-5"
              : "bottom-full left-0 mb-2",
          )}
        >
          <p className="text-sm font-medium">Sign out?</p>
          {email ? (
            <p className="truncate pt-0.5 text-xs text-sidebar-foreground/55">
              {email}
            </p>
          ) : null}
          <div className="mt-3 flex items-center gap-2">
            {/* POST via the BFF logout endpoint, never a GET link (S13) —
                sign-out mutates state and must not fire from a drive-by nav. */}
            <button
              type="button"
              role="menuitem"
              onClick={() => void logout()}
              className="flex-1 rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground transition-colors hover:bg-destructive/90"
            >
              Sign out
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => onOpenChange(false)}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-sidebar-foreground/55 transition-colors hover:bg-white/5 hover:text-sidebar-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
