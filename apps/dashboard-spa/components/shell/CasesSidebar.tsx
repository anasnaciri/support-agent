import { useCallback, useEffect, useRef, useState, type UIEvent } from "react";
import { Search } from "lucide-react";

import type { CaseListRow, CasesFilter } from "@support-agent/dashboard-contracts";
import { Link } from "@/components/ui/link";
import { usePathname } from "@/lib/navigation";
import { api } from "@/lib/api-client";
import { UnauthorizedError } from "@/lib/errors";
import { login } from "@/lib/auth/session-api";
import { useWorkspaceCtx } from "@/lib/session-context";
import { cn } from "@/lib/utils";
import { caseStatusLabel, caseSubjectLabel, hasSubject } from "@/lib/labels";
import { caseStatusVariant } from "@/lib/status-variants";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  LOAD_MORE_THRESHOLD_PX,
  MODE_STORAGE_KEY,
  OVERSCAN,
  ROW_HEIGHT,
  SIDEBAR_PAGE_SIZE,
  applyFreshPage,
  caseIdFromPathname,
  caseRowClasses,
  displayNameFromEmail,
  formatOrderRef,
  initialsFrom,
  isPriorityCase,
  mergeDedupeById,
  parseStoredMode,
  shouldLoadMore,
  sidebarExcludeStatuses,
  sidebarRequestSignature,
  windowRange,
  type SidebarMode,
} from "@/lib/cases-sidebar-data";

// A searchable, virtualized, infinite-scroll case switcher — the secondary
// sidebar on case-detail pages (mirrors the Settings secondary sidebar). Only
// the visible window of rows is rendered; the next page is prefetched as the
// merchant nears the bottom. All the windowing/paging math is pure and
// unit-tested in cases-sidebar-data.ts. SPA port of the Next component: the
// `/api/cases` proxy fetch is replaced by a direct `api.cases` call (cookie
// session), and re-auth on an unrefreshable 401 goes through `login()`.

/** The reference-style filter tabs. Two real modes today (Open/Pending/
 *  Resolved would need per-status api filtering + counts). */
const SIDEBAR_TABS: ReadonlyArray<{
  readonly mode: SidebarMode;
  readonly label: string;
}> = [
  { mode: "all", label: "All" },
  { mode: "attention", label: "Needs attention" },
];

export function CasesSidebar() {
  const pathname = usePathname() ?? "";
  const activeId = caseIdFromPathname(pathname);
  const { workspaceId } = useWorkspaceCtx();

  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  // "all" lists every case; "attention" hides resolved (done) cases. Default
  // is "all"; the remembered choice is restored from localStorage on mount.
  const [mode, setModeState] = useState<SidebarMode>("all");
  const [rows, setRows] = useState<ReadonlyArray<CaseListRow>>([]);
  const [page, setPage] = useState(0);
  const [totalRows, setTotalRows] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Guards against stale responses (an older query/mode resolving late) and
  // overlapping page fetches. latestQueryRef holds the request *signature*
  // (mode + query) so a mode switch supersedes in-flight fetches.
  const latestQueryRef = useRef("");
  const loadingRef = useRef(false);
  // Current query text + mode + workspace, mirrored into refs so the page-fetch
  // callback (stable, empty deps) always reads the live values.
  const debouncedRef = useRef("");
  const modeRef = useRef<SidebarMode>("all");
  const workspaceIdRef = useRef(workspaceId);

  // Restore the remembered mode on mount (client-only); a non-default mode
  // triggers the reset effect, which reloads page 1 with the right filter.
  useEffect(() => {
    const stored = parseStoredMode(
      typeof window === "undefined"
        ? null
        : window.localStorage.getItem(MODE_STORAGE_KEY),
    );
    if (stored !== "all") setModeState(stored);
  }, []);

  const setMode = useCallback((next: SidebarMode) => {
    setModeState(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(MODE_STORAGE_KEY, next);
    }
  }, []);

  const buildFilter = (q: string, activeMode: SidebarMode): CasesFilter => ({
    ...(q ? { q } : {}),
    excludeStatus: [...sidebarExcludeStatuses(activeMode)],
  });

  const fetchPage = useCallback(async (nextPage: number, replace: boolean) => {
    const activeMode = modeRef.current;
    const q = debouncedRef.current;
    const sig = sidebarRequestSignature(activeMode, q);
    loadingRef.current = true;
    setLoading(true);
    try {
      const data = await api.cases(
        { workspaceId: workspaceIdRef.current },
        buildFilter(q, activeMode),
        nextPage,
        SIDEBAR_PAGE_SIZE,
      );
      if (sig !== latestQueryRef.current) return; // a newer request superseded us
      setTotalRows(data.totalRows);
      setPage(data.page);
      setRows((prev) =>
        replace ? [...data.rows] : mergeDedupeById(prev, data.rows),
      );
      setError(false);
    } catch (e) {
      if (e instanceof UnauthorizedError) {
        // Session gone and unrefreshable (U1): re-auth and come back here.
        login();
        return;
      }
      if (sig === latestQueryRef.current) setError(true);
    } finally {
      if (sig === latestQueryRef.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, []);

  // Debounce keystrokes before hitting the network.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  // New search term / mode / workspace → reset and load page 1 (also the initial
  // mount load). Folding mode + workspace in means switching supersedes any
  // in-flight fetch from the old filter.
  useEffect(() => {
    debouncedRef.current = debounced;
    modeRef.current = mode;
    workspaceIdRef.current = workspaceId;
    latestQueryRef.current = sidebarRequestSignature(mode, debounced);
    setRows([]);
    setPage(0);
    setTotalRows(0);
    setError(false);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setScrollTop(0);
    void fetchPage(1, true);
  }, [debounced, mode, workspaceId, fetchPage]);

  // Pathname change ⇒ an action probably just ran (take over, hand back,
  // approve) — but this list is client state, so its status badges would stay
  // stale (U8). Refetch page 1 and fold the fresh rows into what's loaded, in
  // place: no reorder, no scroll jump.
  const mountedPathRef = useRef<string | null>(null);
  useEffect(() => {
    if (mountedPathRef.current === null) {
      // Initial mount — the debounced-query effect already loads page 1.
      mountedPathRef.current = pathname;
      return;
    }
    if (mountedPathRef.current === pathname) return;
    mountedPathRef.current = pathname;
    const activeMode = modeRef.current;
    const q = debouncedRef.current;
    const sig = sidebarRequestSignature(activeMode, q);
    void (async () => {
      try {
        const data = await api.cases(
          { workspaceId: workspaceIdRef.current },
          buildFilter(q, activeMode),
          1,
          SIDEBAR_PAGE_SIZE,
        );
        if (sig !== latestQueryRef.current) return;
        setRows((prev) => applyFreshPage(prev, data.rows));
      } catch {
        // Ignore — purely a freshness top-up.
      }
    })();
  }, [pathname]);

  // Measure the scroll viewport so the window math knows how many rows fit.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewportHeight(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const hasMore = rows.length < totalRows;

  // Top up when the loaded content doesn't yet overflow the viewport, so short
  // first pages still become scrollable / complete.
  useEffect(() => {
    if (loadingRef.current || !hasMore) return;
    if (rows.length * ROW_HEIGHT <= viewportHeight + LOAD_MORE_THRESHOLD_PX) {
      void fetchPage(page + 1, false);
    }
  }, [rows.length, totalRows, viewportHeight, page, hasMore, fetchPage]);

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setScrollTop(el.scrollTop);
    if (
      shouldLoadMore({
        scrollTop: el.scrollTop,
        viewportHeight: el.clientHeight,
        totalHeight: rows.length * ROW_HEIGHT,
        thresholdPx: LOAD_MORE_THRESHOLD_PX,
        hasMore,
        loading: loadingRef.current,
      })
    ) {
      void fetchPage(page + 1, false);
    }
  };

  const { start, end, padTop, totalHeight } = windowRange(
    scrollTop,
    viewportHeight,
    ROW_HEIGHT,
    rows.length,
    OVERSCAN,
  );
  const visible = rows.slice(start, end);
  const initialLoading = loading && rows.length === 0;

  return (
    <div className="flex h-full flex-col">
      <div className="px-3 pb-2 pt-1">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, email, order #…"
            aria-label="Search cases"
            className="w-full rounded-lg border border-border bg-background py-2 pl-8 pr-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
      </div>
      <div
        role="tablist"
        aria-label="Filter cases"
        className="flex items-center gap-4 border-b border-border px-4"
      >
        {SIDEBAR_TABS.map((tab) => {
          const selected = mode === tab.mode;
          return (
            <button
              key={tab.mode}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setMode(tab.mode)}
              className={cn(
                "-mb-px whitespace-nowrap border-b-2 py-2.5 text-[0.8125rem] font-medium transition-colors",
                selected
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="thin-scrollbar min-h-0 flex-1 overflow-y-auto pb-4"
      >
        {initialLoading ? (
          <ul className="space-y-1" aria-hidden>
            {Array.from({ length: 7 }).map((_, i) => (
              <li
                key={i}
                className="h-[88px] animate-pulse rounded-lg bg-muted/60"
              />
            ))}
          </ul>
        ) : rows.length === 0 ? (
          error ? (
            <div className="space-y-3 px-3 py-8 text-center">
              <p className="text-sm italic text-muted-foreground">
                Couldn’t load cases.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void fetchPage(1, true)}
              >
                Retry
              </Button>
            </div>
          ) : (
            <p className="px-3 py-8 text-center text-sm italic text-muted-foreground">
              {debounced ? `No cases match “${debounced}”.` : "No cases yet."}
            </p>
          )
        ) : (
          <div style={{ height: totalHeight }} className="relative">
            <ul
              className="absolute inset-x-0 top-0"
              style={{ transform: `translateY(${padTop}px)` }}
            >
              {visible.map((row) => {
                const active = row.id === activeId;
                // Active row stays elevated; among the rest, resolved (done)
                // cases recede while cases still needing work are bumped.
                const appearance = caseRowClasses({
                  status: row.status,
                  active,
                });
                const name = displayNameFromEmail(row.customerEmail);
                const title = name ?? caseSubjectLabel(row.subject);
                const orderRef = formatOrderRef(row.orderRef);
                return (
                  <li
                    key={row.id}
                    style={{ height: ROW_HEIGHT }}
                    className="border-b border-border"
                  >
                    <Link
                      href={`/cases/${row.id}`}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex h-full gap-2.5 overflow-hidden border-l-2 border-l-transparent px-4 py-2 transition-colors",
                        appearance.container,
                      )}
                    >
                      <div
                        className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[0.6875rem] font-semibold text-primary"
                        aria-hidden
                      >
                        {initialsFrom(row.customerEmail ?? row.subject)}
                      </div>
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <div className="flex items-baseline gap-2">
                          <span
                            className={cn(
                              "min-w-0 flex-1 truncate text-[0.8125rem]",
                              appearance.subject,
                              !name &&
                                !hasSubject(row.subject) &&
                                "italic opacity-70",
                            )}
                          >
                            {title}
                          </span>
                          <span className="shrink-0 font-mono text-[0.6875rem] text-muted-foreground">
                            {row.updatedAt.slice(5, 10)}
                          </span>
                        </div>
                        {name ? (
                          <span
                            className={cn(
                              "truncate text-xs text-muted-foreground",
                              !hasSubject(row.subject) && "italic opacity-70",
                            )}
                          >
                            {caseSubjectLabel(row.subject)}
                          </span>
                        ) : null}
                        {row.preview ? (
                          <span className="truncate text-xs text-muted-foreground">
                            {row.preview}
                          </span>
                        ) : null}
                        <div className="mt-auto flex items-center gap-1.5 overflow-hidden pt-0.5">
                          <Badge
                            variant={caseStatusVariant(row.status)}
                            className="shrink-0 px-1.5 py-0 text-[0.625rem]"
                          >
                            {caseStatusLabel(row.status)}
                          </Badge>
                          {isPriorityCase(row.priority) ? (
                            <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-px text-[0.5625rem] font-bold uppercase tracking-wide text-primary">
                              Priority
                            </span>
                          ) : null}
                          {orderRef ? (
                            <span className="ml-auto shrink-0 font-mono text-[0.6875rem] text-muted-foreground">
                              {orderRef}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {loading && rows.length > 0 ? (
          <p className="py-3 text-center text-xs text-muted-foreground">
            Loading more…
          </p>
        ) : null}
      </div>
    </div>
  );
}
