
import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { usePathname } from "@/lib/navigation";
import { Menu, PanelLeftClose, PanelLeftOpen, X } from "lucide-react";

import guidezillaLogo from "@/guidezilla-logo-dark.svg";

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
import { useIsMobile } from "@/lib/use-media-query";
import { Link } from "@/components/ui/link";
import { IconRail, RailNavContent } from "./IconRail";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { SettingsNav } from "./settings-nav";
import { TicketsSidebar } from "./TicketsSidebar";
import { ticketIdFromPathname } from "@/lib/tickets-sidebar-data";
import { fulfillmentOperatorEscalationIdFromPathname } from "@/lib/fulfillment-operator-ticket-chat";
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
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(readSidebarOpen);
  const [width, setWidth] = useState(readSidebarWidth);
  const [resizing, setResizing] = useState(false);
  // Mobile-only chrome: the nav drawer (hamburger) and the secondary panel
  // rendered as an overlay. Both are transient — never persisted — and close
  // on navigation. The desktop `open`/`width` prefs stay untouched by them.
  const [navOpen, setNavOpen] = useState(false);
  const [mobileSecondaryOpen, setMobileSecondaryOpen] = useState(false);
  const [drawerSignOutOpen, setDrawerSignOutOpen] = useState(false);
  // Latest width without re-subscribing the drag listeners; read on pointer-up
  // to persist, and as the base for each drag.
  const widthRef = useRef(width);
  const dragOriginRef = useRef<{ x: number; width: number } | null>(null);

  // Section-aware secondary sidebar. Settings was the first section to get
  // one; ticket-detail pages get a searchable ticket switcher. Add more entries
  // here as other sections grow sub-navigation.
  const onTicketDetail = Boolean(ticketIdFromPathname(pathname));
  const secondary: SecondarySection | null = pathname.startsWith("/settings")
    ? { title: "Settings", node: <SettingsNav permissions={permissions} /> }
    : onTicketDetail
      ? { title: "Tickets", node: <TicketsSidebar /> }
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

  // Navigating dismisses the mobile drawers (nav links, ticket switcher,
  // settings nav all navigate); crossing to desktop resets them so nothing
  // transient leaks back on the next shrink.
  useEffect(() => {
    setNavOpen(false);
    setMobileSecondaryOpen(false);
    setDrawerSignOutOpen(false);
  }, [pathname, isMobile]);

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

  // Fulfillment partner portal: a constrained external role gets a BARE shell — no merchant
  // icon rail, secondary sidebar, or workspace switcher. Access is enforced by
  // the api (decideFulfillmentOperatorAuthz); this only keeps merchant chrome off their UI.
  // Placed after all hooks above so the rules-of-hooks order is unconditional.
  if (pathname.startsWith("/fulfillment-operator")) {
    return (
      <div
        className={cn(
          "flex flex-col bg-background",
          // The escalation-detail chat needs a definite height to fill (its
          // bubbles scroll, its composer pins); document routes keep growing.
          fulfillmentOperatorEscalationIdFromPathname(pathname)
            ? "h-dvh"
            : "min-h-dvh",
        )}
      >
        <header className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold tracking-tight">
              Fulfillment partner portal
            </span>
            {/* Cross-org switcher: a fulfillment partner serving several merchants (and a
                dual-role user with their own store) switches workspaces here. */}
            <WorkspaceSwitcher variant="header" />
          </div>
          <div className="flex items-center gap-3">
            {email ? (
              <span className="hidden text-xs text-muted-foreground sm:inline">
                {email}
              </span>
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
        {fulfillmentOperatorEscalationIdFromPathname(pathname) ? (
          // The escalation detail is a full-height chat (its own scroll +
          // pinned composer), so it runs edge-to-edge like the merchant
          // ticket view; every other fulfillment partner route keeps the centered,
          // scrollable document layout.
          <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
        ) : (
          <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 sm:py-8">
            <div className="mx-auto w-full max-w-3xl">{children}</div>
          </main>
        )}
      </div>
    );
  }

  // Mobile (< md): no icon rail. A slim dark top bar carries a hamburger that
  // opens the full labeled nav as a drawer; the secondary panel (settings nav /
  // ticket switcher) becomes an overlay drawer, closed by default regardless
  // of the persisted desktop preference. Branching in JS (not CSS) keeps one
  // DOM tree per mode — the virtualized ticket sidebar and the drag-resize
  // handle never exist on mobile.
  if (isMobile) {
    return (
      <div className="flex h-dvh flex-col overflow-hidden bg-sidebar">
        <header className="flex h-12 shrink-0 items-center gap-1.5 px-2 text-sidebar-foreground">
          <button
            type="button"
            onClick={() => setNavOpen(true)}
            aria-label="Open navigation"
            aria-expanded={navOpen}
            className="flex size-9 items-center justify-center rounded-lg text-sidebar-foreground/70 transition-colors hover:bg-white/5 hover:text-sidebar-foreground"
          >
            <Menu className="size-5" aria-hidden />
          </button>
          <Link
            href="/"
            aria-label="Guidezilla home"
            className="flex items-center gap-2"
          >
            <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md bg-[#0345FC]">
              <img
                src={guidezillaLogo}
                alt=""
                aria-hidden
                className="size-7 object-contain"
              />
            </span>
            <span className="font-[family-name:var(--font-climate-crisis)] text-base tracking-wide">
              Guidezilla
            </span>
          </Link>
        </header>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
          {/* Secondary sections get a slim sub-header opening the overlay —
              except ticket detail, whose own header leaves room (pl-14) for
              the floating expand button instead. */}
          {secondary && !onTicketDetail ? (
            <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-2 py-1.5">
              <button
                type="button"
                onClick={() => setMobileSecondaryOpen(true)}
                aria-label={`Show ${secondary.title} panel`}
                aria-expanded={mobileSecondaryOpen}
                className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <PanelLeftOpen className="size-4" aria-hidden />
              </button>
              <span className="text-sm font-medium">{secondary.title}</span>
            </div>
          ) : null}

          <main
            className={cn(
              "relative min-w-0 flex-1",
              onTicketDetail ? "overflow-hidden" : "overflow-y-auto px-4 py-6",
            )}
          >
            {secondary && onTicketDetail ? (
              <button
                type="button"
                onClick={() => setMobileSecondaryOpen(true)}
                aria-label={`Show ${secondary.title} panel`}
                aria-expanded={mobileSecondaryOpen}
                className="absolute left-3 top-3 z-10 flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <PanelLeftOpen className="size-4" aria-hidden />
              </button>
            ) : null}
            {onTicketDetail ? (
              // Always "collapsed" on mobile: the secondary panel is an
              // overlay, so the ticket header keeps its indent for the
              // floating expand button.
              <div className="group/ticket h-full" data-sidebar-state="collapsed">
                {children}
              </div>
            ) : (
              <div className="mx-auto w-full max-w-5xl">{children}</div>
            )}
          </main>
        </div>

        {/* Nav drawer — the rail's content with labels always visible. */}
        {navOpen ? (
          <div
            className="fixed inset-0 z-40 bg-foreground/40"
            onClick={() => setNavOpen(false)}
            aria-hidden
          />
        ) : null}
        <div
          inert={!navOpen}
          className={cn(
            "fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col bg-sidebar px-3 py-4 text-sidebar-foreground shadow-xl transition-transform duration-300 ease-in-out",
            navOpen ? "translate-x-0" : "-translate-x-full",
          )}
        >
          <button
            type="button"
            onClick={() => setNavOpen(false)}
            aria-label="Close navigation"
            className="absolute right-2 top-2 flex size-8 items-center justify-center rounded-md text-sidebar-foreground/55 transition-colors hover:bg-white/5 hover:text-sidebar-foreground"
          >
            <X className="size-4" aria-hidden />
          </button>
          <RailNavContent
            email={email}
            workspaces={workspaces}
            activeWorkspaceId={activeWorkspaceId}
            permissions={permissions}
            expanded
            onNavigate={() => setNavOpen(false)}
            signOutOpen={drawerSignOutOpen}
            onSignOutOpenChange={setDrawerSignOutOpen}
          />
        </div>

        {/* Secondary panel as an overlay drawer. */}
        {secondary ? (
          <>
            {mobileSecondaryOpen ? (
              <div
                className="fixed inset-0 z-40 bg-foreground/40"
                onClick={() => setMobileSecondaryOpen(false)}
                aria-hidden
              />
            ) : null}
            <div
              inert={!mobileSecondaryOpen}
              className={cn(
                "fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-border/50 bg-background shadow-xl transition-transform duration-300 ease-in-out",
                mobileSecondaryOpen ? "translate-x-0" : "-translate-x-full",
              )}
            >
              <div className="flex items-center justify-between px-5 pb-2 pt-5">
                <h2 className="text-lg font-semibold tracking-tight">
                  {secondary.title}
                </h2>
                <button
                  type="button"
                  onClick={() => setMobileSecondaryOpen(false)}
                  aria-label="Hide panel"
                  className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <X className="size-4" aria-hidden />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {secondary.node}
              </div>
            </div>
          </>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex h-dvh overflow-hidden bg-sidebar">
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
              // The ticket-detail view is a full-height inbox (chat + details
              // columns that own their own scroll), so it runs edge-to-edge
              // with no page padding or max-width. Every other route keeps the
              // centered, scrollable document layout.
              onTicketDetail
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
            {onTicketDetail ? (
              // `group/ticket` + the sidebar state lets the ticket header pad its
              // left only while the floating expand button is showing (sidebar
              // collapsed), with no gap when the sidebar is open.
              <div
                className="group/ticket h-full"
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
