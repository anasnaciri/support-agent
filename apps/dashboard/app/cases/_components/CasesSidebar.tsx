"use client";

import { useCallback, useEffect, useRef, useState, type UIEvent } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Inbox, List, Search } from "lucide-react";

import type { CaseListRow, Page } from "@support-agent/dashboard-contracts";
import { cn } from "@/lib/utils";
import { buildSignInRedirect } from "@/lib/auth-redirect";
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
  mergeDedupeById,
  parseStoredMode,
  shouldLoadMore,
  sidebarExcludeStatuses,
  sidebarRequestSignature,
  windowRange,
  type SidebarMode,
} from "./cases-sidebar-data";

// A searchable, virtualized, infinite-scroll case switcher — the secondary
// sidebar on case-detail pages (mirrors the Settings secondary sidebar).
// Only the visible window of rows is rendered; the next page is prefetched as
// the merchant nears the bottom. All the windowing/paging math is pure and
// unit-tested in cases-sidebar-data.ts.

export function CasesSidebar() {
  const pathname = usePathname() ?? "";
  const activeId = caseIdFromPathname(pathname);

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
  // Current query text + mode, mirrored into refs so the page-fetch callback
  // (stable, empty deps) always reads the live values.
  const debouncedRef = useRef("");
  const modeRef = useRef<SidebarMode>("all");

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

  const fetchPage = useCallback(
    async (nextPage: number, replace: boolean) => {
      const activeMode = modeRef.current;
      const q = debouncedRef.current;
      const sig = sidebarRequestSignature(activeMode, q);
      loadingRef.current = true;
      setLoading(true);
      try {
        const params = new URLSearchParams({
          page: String(nextPage),
          limit: String(SIDEBAR_PAGE_SIZE),
        });
        if (q) params.set("q", q);
        for (const s of sidebarExcludeStatuses(activeMode)) {
          params.append("excludeStatus", s);
        }
        const res = await fetch(`/api/cases?${params.toString()}`, {
          cache: "no-store",
        });
        if (res.status === 401) {
          // Session gone and unrefreshable (U1): re-auth and come back here.
          window.location.assign(
            buildSignInRedirect(
              `${window.location.pathname}${window.location.search}`,
            ),
          );
          return;
        }
        if (!res.ok) throw new Error(`cases ${res.status}`);
        const data = (await res.json()) as Page<CaseListRow>;
        if (sig !== latestQueryRef.current) return; // a newer request superseded us
        setTotalRows(data.totalRows);
        setPage(data.page);
        setRows((prev) =>
          replace ? [...data.rows] : mergeDedupeById(prev, data.rows),
        );
        setError(false);
      } catch {
        if (sig === latestQueryRef.current) setError(true);
      } finally {
        if (sig === latestQueryRef.current) {
          loadingRef.current = false;
          setLoading(false);
        }
      }
    },
    [],
  );

  // Debounce keystrokes before hitting the network.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  // New search term or mode → reset and load page 1 (also the initial mount
  // load). Folding mode in means switching All ↔ Needs attention reloads with
  // the right filter and supersedes any in-flight fetch from the old mode.
  useEffect(() => {
    debouncedRef.current = debounced;
    modeRef.current = mode;
    latestQueryRef.current = sidebarRequestSignature(mode, debounced);
    setRows([]);
    setPage(0);
    setTotalRows(0);
    setError(false);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setScrollTop(0);
    void fetchPage(1, true);
  }, [debounced, mode, fetchPage]);

  // Pathname change ⇒ a server action probably just ran (take over, hand
  // back, approve) and revalidated the page — but this list is client state,
  // so its status badges would stay stale (U8). Refetch page 1 and fold the
  // fresh rows into what's loaded, in place: no reorder, no scroll jump.
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
        const params = new URLSearchParams({
          page: "1",
          limit: String(SIDEBAR_PAGE_SIZE),
        });
        if (q) params.set("q", q);
        for (const s of sidebarExcludeStatuses(activeMode)) {
          params.append("excludeStatus", s);
        }
        const res = await fetch(`/api/cases?${params.toString()}`, {
          cache: "no-store",
        });
        if (!res.ok) return; // best-effort freshness; the poller/Retry handle errors
        const data = (await res.json()) as Page<CaseListRow>;
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

  // Top up when the loaded content doesn't yet overflow the viewport, so
  // short first pages still become scrollable / complete.
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
      <div className="space-y-2 px-3 pb-3">
        <div
          className="inline-flex rounded-md border border-border bg-muted/40 p-0.5"
          role="group"
          aria-label="Filter cases"
        >
          <button
            type="button"
            onClick={() => setMode("all")}
            aria-pressed={mode === "all"}
            aria-label="All cases"
            title="All cases"
            className={cn(
              "inline-flex size-7 items-center justify-center rounded transition-colors",
              mode === "all"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <List className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => setMode("attention")}
            aria-pressed={mode === "attention"}
            aria-label="Needs attention"
            title="Needs attention"
            className={cn(
              "inline-flex size-7 items-center justify-center rounded transition-colors",
              mode === "attention"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Inbox className="size-4" aria-hidden />
          </button>
        </div>
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search cases…"
            aria-label="Search cases"
            className="w-full rounded-md border border-border bg-background py-2 pl-8 pr-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-4"
      >
        {initialLoading ? (
          <ul className="space-y-1" aria-hidden>
            {Array.from({ length: 7 }).map((_, i) => (
              <li
                key={i}
                className="h-16 animate-pulse rounded-md bg-muted/60"
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
                return (
                  <li key={row.id} style={{ height: ROW_HEIGHT }} className="py-1">
                    <Link
                      href={`/cases/${row.id}`}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex h-full flex-col justify-center gap-1 rounded-lg px-3 transition-colors",
                        appearance.container,
                      )}
                    >
                      <span
                        className={cn(
                          "truncate text-sm",
                          appearance.subject,
                          !hasSubject(row.subject) && "italic opacity-70",
                        )}
                      >
                        {caseSubjectLabel(row.subject)}
                      </span>
                      <span className="flex items-center gap-2 overflow-hidden">
                        <Badge
                          variant={caseStatusVariant(row.status)}
                          className="shrink-0 px-1.5 py-0 text-[10px]"
                        >
                          {caseStatusLabel(row.status)}
                        </Badge>
                        <span className="ml-auto shrink-0 tabular-nums text-xs text-muted-foreground">
                          {row.updatedAt.slice(5, 10)}
                        </span>
                      </span>
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
