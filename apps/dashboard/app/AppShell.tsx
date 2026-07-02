"use client";

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

import type {
  RbacPermissionId,
  UnifiedWorkspace,
} from "@support-agent/dashboard-contracts";

import { cn } from "@/lib/utils";
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
} from "@/lib/sidebar-width";
import { IconRail } from "./IconRail";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { SettingsNav } from "./settings/_components/settings-nav";
import { CasesSidebar } from "./cases/_components/CasesSidebar";
import { caseIdFromPathname } from "./cases/_components/cases-sidebar-data";
import { signOutAction } from "./sign-out-action";

const SIDEBAR_COOKIE = "sidebar:state";
const WIDTH_COOKIE = "sidebar:width";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;
const RESIZE_STEP = 16;

interface SecondarySection {
  readonly title: string;
  readonly node: ReactNode;
}

interface Props {
  readonly email: string | null;
  /** Workspaces for the rail's switcher; null → signed out / pre-onboarding. */
  readonly workspaces: ReadonlyArray<UnifiedWorkspace> | null;
  readonly activeWorkspaceId: string | null;
  /** Member's effective permissions for nav gating; null → fail-open (show all). */
  readonly permissions: ReadonlyArray<RbacPermissionId> | null;
  readonly defaultOpen: boolean;
  readonly defaultWidth: number;
  readonly children: ReactNode;
}

export function AppShell({
  email,
  workspaces,
  activeWorkspaceId,
  permissions,
  defaultOpen,
  defaultWidth,
  children,
}: Props) {
  const pathname = usePathname() ?? "/";
  const [open, setOpen] = useState(defaultOpen);
  const [width, setWidth] = useState(defaultWidth);
  const [resizing, setResizing] = useState(false);
  // Latest width without re-subscribing the drag listeners; read on pointer-up
  // to persist, and as the base for each drag.
  const widthRef = useRef(defaultWidth);
  const dragOriginRef = useRef<{ x: number; width: number } | null>(null);

  // Section-aware secondary sidebar. Settings was the first section to get
  // one; case-detail pages get a searchable case switcher. Add more entries
  // here as other sections grow sub-navigation.
  const onCaseDetail = Boolean(caseIdFromPathname(pathname));
  const secondary: SecondarySection | null = pathname.startsWith("/settings")
    ? { title: "Settings", node: <SettingsNav permissions={permissions} /> }
    : onCaseDetail
      ? { title: "Cases", node: <CasesSidebar /> }
      : null;

  const setOpenPersisted = (next: boolean) => {
    setOpen(next);
    document.cookie = `${SIDEBAR_COOKIE}=${
      next ? "open" : "closed"
    }; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`;
  };

  const persistWidth = (w: number) => {
    document.cookie = `${WIDTH_COOKIE}=${w}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`;
  };

  // Keyboard nudges on the resize handle (arrow keys), persisted immediately.
  const setWidthPersisted = (next: number) => {
    const w = clampSidebarWidth(next);
    widthRef.current = w;
    setWidth(w);
    persistWidth(w);
  };

  const onResizeStart = (e: ReactPointerEvent) => {
    e.preventDefault();
    dragOriginRef.current = { x: e.clientX, width: widthRef.current };
    setResizing(true);
  };

  // While dragging, follow the pointer on the window (so the cursor can leave
  // the 6px handle) and persist once on release.
  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: PointerEvent) => {
      const origin = dragOriginRef.current;
      if (!origin) return;
      const w = clampSidebarWidth(origin.width + (e.clientX - origin.x));
      widthRef.current = w;
      setWidth(w);
    };
    const onUp = () => {
      dragOriginRef.current = null;
      setResizing(false);
      persistWidth(widthRef.current);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
    };
  }, [resizing]);

  // Supplier portal: a constrained external role gets a BARE shell — no merchant
  // icon rail, secondary sidebar, or workspace switcher. Access is enforced by
  // the api (decideSupplierAuthz); this only keeps merchant chrome off their UI.
  // Placed after all hooks above so the rules-of-hooks order is unconditional.
  if (pathname.startsWith("/supplier")) {
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <header className="flex items-center justify-between border-b border-border/60 px-6 py-3">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold tracking-tight">
              Supplier portal
            </span>
            {/* Cross-org switcher: a supplier serving several merchants (and a
                dual-role user with their own store) switches workspaces here. */}
            {workspaces && activeWorkspaceId ? (
              <WorkspaceSwitcher
                variant="header"
                workspaces={workspaces}
                activeWorkspaceId={activeWorkspaceId}
              />
            ) : null}
          </div>
          <div className="flex items-center gap-3">
            {email ? (
              <span className="text-xs text-muted-foreground">{email}</span>
            ) : null}
            <form action={signOutAction}>
              <button
                type="submit"
                className="rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                Sign out
              </button>
            </form>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
          <div className="mx-auto w-full max-w-3xl">{children}</div>
        </main>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-sidebar">
      <IconRail
        email={email}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        permissions={permissions}
      />

      {/* pt-3 reveals a sliver of the dark frame so the off-white panel reads
          as floating, matching the rest of the app. */}
      <div className="flex min-w-0 flex-1 overflow-hidden pt-3">
        <div className="flex min-w-0 flex-1 overflow-hidden rounded-tl-2xl bg-background">
          {secondary ? (
            // Width animates between the panel width and 0; the inner aside
            // keeps a fixed width so its contents slide out cleanly rather
            // than reflowing as the container shrinks.
            <div
              aria-hidden={!open}
              className={cn(
                "shrink-0 overflow-hidden",
                // No width transition mid-drag, or the panel lags the pointer.
                resizing ? "" : "transition-[width] duration-300 ease-in-out",
              )}
              style={{ width: open ? width : 0 }}
            >
              <aside
                className="relative flex h-full flex-col border-r border-border/50"
                style={{ width }}
              >
                <div className="flex items-center justify-between px-5 pb-2 pt-5">
                  <h2 className="text-lg font-semibold tracking-tight">
                    {secondary.title}
                  </h2>
                  <button
                    type="button"
                    onClick={() => setOpenPersisted(false)}
                    tabIndex={open ? 0 : -1}
                    className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    aria-label="Collapse sidebar"
                    title="Collapse sidebar"
                  >
                    <PanelLeftClose className="size-4" aria-hidden />
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {secondary.node}
                </div>

                {/* Invisible drag handle on the right edge — the col-resize
                    cursor is the only affordance (no colored indicator);
                    keyboard-resizable with a neutral focus hint for a11y. */}
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize sidebar"
                  aria-valuenow={width}
                  aria-valuemin={SIDEBAR_MIN_WIDTH}
                  aria-valuemax={SIDEBAR_MAX_WIDTH}
                  tabIndex={open ? 0 : -1}
                  onPointerDown={onResizeStart}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowLeft") {
                      e.preventDefault();
                      setWidthPersisted(widthRef.current - RESIZE_STEP);
                    } else if (e.key === "ArrowRight") {
                      e.preventDefault();
                      setWidthPersisted(widthRef.current + RESIZE_STEP);
                    }
                  }}
                  className="absolute inset-y-0 right-0 z-20 w-1.5 cursor-col-resize touch-none bg-transparent outline-none focus-visible:bg-foreground/10"
                />
              </aside>
            </div>
          ) : null}

          <main
            className={cn(
              "relative min-w-0 flex-1",
              // The case-detail view is a full-height inbox (chat + details
              // columns that own their own scroll), so it runs edge-to-edge
              // with no page padding or max-width. Every other route keeps the
              // centered, scrollable document layout.
              onCaseDetail
                ? "overflow-hidden"
                : "overflow-y-auto px-8 py-8",
              // Content reads as a raised plane casting a soft shadow toward
              // the secondary sidebar — depth at the seam, no hard divider.
              secondary && open
                ? "shadow-[-6px_0_20px_-14px_rgba(0,0,0,0.12)]"
                : "",
            )}
          >
            {secondary ? (
              <button
                type="button"
                onClick={() => setOpenPersisted(true)}
                tabIndex={open ? -1 : 0}
                className={cn(
                  "absolute left-3 top-3 z-10 flex size-9 items-center justify-center rounded-md text-muted-foreground transition-opacity duration-200 ease-in-out hover:bg-accent hover:text-foreground",
                  open ? "pointer-events-none opacity-0" : "opacity-100",
                )}
                aria-label="Expand sidebar"
                title="Expand sidebar"
              >
                <PanelLeftOpen className="size-4" aria-hidden />
              </button>
            ) : null}
            {onCaseDetail ? (
              // `group/case` + the sidebar state lets the case header pad its
              // left only while the floating expand button is showing (sidebar
              // collapsed), with no gap when the sidebar is open.
              <div
                className="group/case h-full"
                data-sidebar-state={open ? "open" : "collapsed"}
              >
                {children}
              </div>
            ) : (
              <div className="mx-auto w-full max-w-5xl">{children}</div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
