
import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { usePathname } from "@/lib/navigation";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

import type {
  RbacPermissionId,
  WorkspaceSummary,
} from "@support-agent/dashboard-contracts";

import { cn } from "@/lib/utils";
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  parseSidebarWidth,
} from "@/lib/sidebar-width";
import { IconRail } from "./IconRail";
import { SettingsNav } from "./settings-nav";
import { CasesSidebar } from "./CasesSidebar";
import { caseIdFromPathname } from "@/lib/cases-sidebar-data";
import { supplierEscalationIdFromPathname } from "@/lib/supplier-case-chat";
import { logout } from "@/lib/auth/session-api";

const SIDEBAR_KEY = "sidebar:state";
const WIDTH_KEY = "sidebar:width";
const RESIZE_STEP = 16;

// Client-side persistence of the sidebar's open/width prefs. In the Next app
// these were cookies read server-side to avoid a flash; the SPA reads them from
// localStorage at mount (a brief default flash on first paint is acceptable).
const readSidebarOpen = (): boolean => {
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== "closed";
  } catch {
    return true;
  }
};
const readSidebarWidth = (): number => {
  try {
    return parseSidebarWidth(localStorage.getItem(WIDTH_KEY) ?? undefined);
  } catch {
    return parseSidebarWidth(undefined);
  }
};

interface SecondarySection {
  readonly title: string;
  readonly node: ReactNode;
}

interface Props {
  readonly email: string | null;
  /** Workspaces for the rail's switcher; null → signed out / pre-onboarding. */
  readonly workspaces: ReadonlyArray<WorkspaceSummary> | null;
  readonly activeWorkspaceId: string | null;
  /** Member's effective permissions for nav gating; null → fail-open (show all). */
  readonly permissions: ReadonlyArray<RbacPermissionId> | null;
  readonly children: ReactNode;
}

export function AppShell({
  email,
  workspaces,
  activeWorkspaceId,
  permissions,
  children,
}: Props) {
  const pathname = usePathname() ?? "/";
  const [open, setOpen] = useState(readSidebarOpen);
  const [width, setWidth] = useState(readSidebarWidth);
  const [resizing, setResizing] = useState(false);
  // Latest width without re-subscribing the drag listeners; read on pointer-up
  // to persist, and as the base for each drag.
  const widthRef = useRef(width);
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
    try {
      localStorage.setItem(SIDEBAR_KEY, next ? "open" : "closed");
    } catch {
      /* private mode — prefs just don't persist */
    }
  };

  const persistWidth = (w: number) => {
    try {
      localStorage.setItem(WIDTH_KEY, String(w));
    } catch {
      /* private mode */
    }
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
      <div
        className={cn(
          "flex flex-col bg-background",
          // The escalation-detail chat needs a definite height to fill (its
          // bubbles scroll, its composer pins); document routes keep growing.
          supplierEscalationIdFromPathname(pathname)
            ? "h-screen"
            : "min-h-screen",
        )}
      >
        <header className="flex items-center justify-between border-b border-border/60 px-6 py-3">
          <span className="text-sm font-semibold tracking-tight">
            Supplier portal
          </span>
          <div className="flex items-center gap-3">
            {email ? (
              <span className="text-xs text-muted-foreground">{email}</span>
            ) : null}
            <button
              type="button"
              onClick={() => void logout()}
              className="rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              Sign out
            </button>
          </div>
        </header>
        {supplierEscalationIdFromPathname(pathname) ? (
          // The escalation detail is a full-height chat (its own scroll +
          // pinned composer), so it runs edge-to-edge like the merchant
          // case view; every other supplier route keeps the centered,
          // scrollable document layout.
          <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
        ) : (
          <main className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
            <div className="mx-auto w-full max-w-3xl">{children}</div>
          </main>
        )}
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
