
import { useEffect, useRef, useState } from "react";
import { Link } from "@/components/ui/link";
import { Check, ChevronsUpDown, Plus } from "lucide-react";

import { cn } from "@/lib/utils";
import { useSession } from "@/lib/session-context";

interface Props {
  /** "rail" = the dark merchant icon rail; "header" = the light supplier bar. */
  readonly variant?: "rail" | "header";
  /**
   * Where the menu opens relative to the trigger. Defaults per variant
   * ("rail" → beside it, "header" → below-right); the mobile nav drawer
   * overrides the rail trigger to "below" so the menu stays inside the
   * drawer instead of opening past its right edge.
   */
  readonly menuPlacement?: "right" | "below" | "below-right";
}

/**
 * The unified workspace menu. Lists EVERY workspace the user can reach —
 * merchant (their stores) AND supplier (merchants that escalate to them) — each
 * tagged by kind. Selecting one switches the active workspace and routes to that
 * surface (merchant dashboard vs the supplier portal). Reads the merged list
 * straight from the session so both shells share one source of truth.
 */
export function WorkspaceSwitcher({ variant = "rail", menuPlacement }: Props) {
  const { workspaces, activeWorkspaceId, setActiveWorkspace } = useSession();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const active =
    workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0];
  const hasMerchantWorkspace = workspaces.some((w) => w.kind === "merchant");

  // Close on outside click / Escape, like a native menu.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!active) return null;
  // In the supplier header the switcher only earns its place with a choice.
  if (variant === "header" && workspaces.length < 2) return null;

  const menu = (
    <div
      role="menu"
      aria-label="Workspaces"
      className={cn(
        "z-50 w-64 rounded-lg border border-border bg-background py-1.5 text-foreground shadow-lg",
        {
          right: "absolute left-full top-0 ml-3",
          below: "absolute left-0 top-full mt-2",
          "below-right": "absolute right-0 top-full mt-2",
        }[menuPlacement ?? (variant === "rail" ? "right" : "below-right")],
      )}
    >
      <p className="px-3 pb-1 pt-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Workspaces
      </p>
      {workspaces.map((w) => (
        <button
          key={w.id}
          type="button"
          role="menuitem"
          onClick={() => {
            setOpen(false);
            if (w.id !== active.id) setActiveWorkspace(w.id);
          }}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
        >
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold uppercase">
            {w.name.slice(0, 1)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="block truncate font-medium">{w.name}</span>
              {w.kind === "supplier" ? (
                <span className="shrink-0 rounded-sm bg-muted px-1 py-px text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground">
                  Supplier
                </span>
              ) : null}
            </span>
            {w.shopifyDomain ? (
              <span className="block truncate text-xs text-muted-foreground">
                {w.shopifyDomain}
              </span>
            ) : null}
          </span>
          {w.id === active.id ? (
            <Check className="size-4 shrink-0 text-primary" aria-hidden />
          ) : null}
        </button>
      ))}
      {hasMerchantWorkspace ? (
        <>
          <div className="my-1.5 border-t border-border" aria-hidden />
          <Link
            href="/workspaces/new"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            <span className="flex size-6 items-center justify-center rounded-md border border-dashed border-muted-foreground/40">
              <Plus className="size-3.5" aria-hidden />
            </span>
            New workspace
          </Link>
        </>
      ) : null}
    </div>
  );

  if (variant === "header") {
    return (
      <div ref={rootRef} className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Switch workspace (current: ${active.name})`}
          className="flex items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent"
        >
          <span className="max-w-[10rem] truncate">{active.name}</span>
          <ChevronsUpDown className="size-3.5 text-muted-foreground" aria-hidden />
        </button>
        {open ? menu : null}
      </div>
    );
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={`Workspace: ${active.name}`}
        aria-label={`Switch workspace (current: ${active.name})`}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          "group flex size-10 items-center justify-center rounded-lg text-sm font-semibold uppercase transition-colors",
          open
            ? "bg-white/10 text-sidebar-foreground"
            : "bg-white/5 text-sidebar-foreground/80 hover:bg-white/10 hover:text-sidebar-foreground",
        )}
      >
        <span aria-hidden>{active.name.slice(0, 1)}</span>
        <ChevronsUpDown
          className="absolute -right-1 bottom-0 size-3 rounded-sm bg-sidebar text-sidebar-foreground/50 group-hover:text-sidebar-foreground/80"
          aria-hidden
        />
      </button>
      {open ? menu : null}
    </div>
  );
}
