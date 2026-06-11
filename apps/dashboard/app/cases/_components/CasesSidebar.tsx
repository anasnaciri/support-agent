"use client";

import { useCallback, useEffect, useRef, useState, type UIEvent } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Search } from "lucide-react";

import type { CaseListRow, Page } from "@support-agent/dashboard-contracts";
import { cn } from "@/lib/utils";
import { buildSignInRedirect } from "@/lib/auth-redirect";
import { caseStatusVariant } from "@/lib/status-variants";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  LOAD_MORE_THRESHOLD_PX,
  OVERSCAN,
  ROW_HEIGHT,
  SIDEBAR_PAGE_SIZE,
  applyFreshPage,
  caseIdFromPathname,
  mergeDedupeById,
  shouldLoadMore,
  windowRange,
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
  const [rows, setRows] = useState<ReadonlyArray<CaseListRow>>([]);
  const [page, setPage] = useState(0);
  const [totalRows, setTotalRows] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Guards against stale responses (an older query resolving late) and
  // overlapping page fetches.
  const latestQueryRef = useRef("");
  const loadingRef = useRef(false);

  const fetchPage = useCallback(
    async (q: string, nextPage: number, replace: boolean) => {
      loadingRef.current = true;
      setLoading(true);
      try {
        const params = new URLSearchParams({
          page: String(nextPage),
          limit: String(SIDEBAR_PAGE_SIZE),
        });
        if (q) params.set("q", q);
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
        if (q !== latestQueryRef.current) return; // a newer query superseded us
        setTotalRows(data.totalRows);
        setPage(data.page);
        setRows((prev) =>
          replace ? [...data.rows] : mergeDedupeById(prev, data.rows),
        );
        setError(false);
      } catch {
        if (q === latestQueryRef.current) setError(true);
      } finally {
        if (q === latestQueryRef.current) {
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

  // New search term → reset and load page 1 (also the initial mount load).
  useEffect(() => {
    latestQueryRef.current = debounced;
    setRows([]);
    setPage(0);
    setTotalRows(0);
    setError(false);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setScrollTop(0);
    void fetchPage(debounced, 1, true);
  }, [debounced, fetchPage]);

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
    const q = latestQueryRef.current;
    void (async () => {
      try {
        const params = new URLSearchParams({
          page: "1",
          limit: String(SIDEBAR_PAGE_SIZE),
        });
        if (q) params.set("q", q);
        const res = await fetch(`/api/cases?${params.toString()}`, {
          cache: "no-store",
        });
        if (!res.ok) return; // best-effort freshness; the poller/Retry handle errors
        const data = (await res.json()) as Page<CaseListRow>;
        if (q !== latestQueryRef.current) return;
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
      void fetchPage(latestQueryRef.current, page + 1, false);
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
      void fetchPage(latestQueryRef.current, page + 1, false);
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
      <div className="px-3 pb-3">
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
                onClick={() => void fetchPage(latestQueryRef.current, 1, true)}
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
                return (
                  <li key={row.id} style={{ height: ROW_HEIGHT }} className="py-1">
                    <Link
                      href={`/cases/${row.id}`}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex h-full flex-col justify-center gap-1 rounded-lg px-3 transition-colors",
                        // Active = an elevated neutral surface (depth via shadow,
                        // not a colored indicator); inactive recesses on hover.
                        active
                          ? "bg-card shadow-[0_2px_8px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)] ring-1 ring-black/5 dark:ring-white/10"
                          : "hover:bg-accent",
                      )}
                    >
                      <span
                        className={cn(
                          "truncate text-sm text-foreground",
                          active && "font-medium",
                        )}
                      >
                        {row.subject ?? "(no subject)"}
                      </span>
                      <span className="flex items-center gap-2 overflow-hidden">
                        <Badge
                          variant={caseStatusVariant(row.status)}
                          className="shrink-0 px-1.5 py-0 text-[10px]"
                        >
                          {row.status}
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
