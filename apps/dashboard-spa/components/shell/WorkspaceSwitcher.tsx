
import { useEffect, useRef, useState } from "react";
import { Link } from "@/components/ui/link";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import type { WorkspaceSummary } from "@support-agent/dashboard-contracts";

import { cn } from "@/lib/utils";
import { useSession } from "@/lib/session-context";

interface Props {
  readonly workspaces: ReadonlyArray<WorkspaceSummary>;
  readonly activeWorkspaceId: string;
}

/**
 * The rail's workspace menu: the active workspace's initial as the trigger,
 * a popover anchored beside the rail listing every workspace (switch =
 * server action → cookie + reload) and a "New workspace" entry. Hidden
 * entirely (by the parent) when the org has no workspaces yet.
 */
export function WorkspaceSwitcher({ workspaces, activeWorkspaceId }: Props) {
  const { setActiveWorkspace } = useSession();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const active =
    workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0];

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

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={`Workspace — ${active.name}`}
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

      {open ? (
        <div
          role="menu"
          aria-label="Workspaces"
          className="absolute left-full top-0 z-50 ml-3 w-64 rounded-lg border border-border bg-background py-1.5 text-foreground shadow-lg"
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
                <span className="block truncate font-medium">{w.name}</span>
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
        </div>
      ) : null}
    </div>
  );
}
