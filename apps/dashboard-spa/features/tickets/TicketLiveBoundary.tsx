import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { cn } from "@/lib/utils";
import { isPaused, nextFailureCount } from "@/lib/live-status";

const POLL_MS = 2500;

// Live-updates badge for the ticket page (Phase 5). The Next app re-fetched the
// whole Server Component via `router.refresh()`; here we poll the same
// cursor-based `?since=` events endpoint on an interval and, when new audit
// events arrive, advance the cursor and invalidate the ticket detail query
// prefix `["ticket", w, id]` — which also covers the thread/shopify/tracking
// sub-queries — so the timeline + panels refetch. We only invalidate when a
// NEW event id appears, so idle polling never triggers a refetch storm across
// open tabs. 401s are handled globally by the api-client (typed error →
// sign-in nav), so there's no auth branch here. The pure failure-streak logic
// (paused-after-3, U11) lives in `lib/live-status.ts` and is unit-tested.
export function TicketLiveBoundary({ ticketId }: { readonly ticketId: string }) {
  const ctx = useWorkspaceCtx();
  const qc = useQueryClient();

  // Cursor: the highest audit id we've observed. `null`/unprimed until the
  // first successful poll seeds it. That first poll only seeds the cursor — it
  // never invalidates — so opening a ticket doesn't immediately refetch what we
  // just loaded.
  const sinceRef = useRef<string | null>(null);
  const primedRef = useRef(false);
  const failuresRef = useRef(0);
  const [failures, setFailures] = useState(0);

  const query = useQuery({
    queryKey: qk.ticketEvents(ctx.workspaceId, ticketId),
    queryFn: () => api.ticketEvents(ctx, ticketId, sinceRef.current ?? "0"),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
    // The poll interval IS the retry — a transient failure just shows the amber
    // dot and is re-attempted on the next tick.
    retry: false,
    gcTime: 0,
  });

  const { dataUpdatedAt, errorUpdatedAt, isError, data } = query;

  useEffect(() => {
    // Nothing has settled yet — don't count the initial pending state as a
    // failure.
    if (dataUpdatedAt === 0 && errorUpdatedAt === 0) return;

    const ok = !isError && data != null;
    failuresRef.current = nextFailureCount(failuresRef.current, ok);
    setFailures(failuresRef.current);
    if (!ok || !data) return;

    const events = data.events;
    const newest = events.length > 0 ? events[events.length - 1]!.id : null;

    if (!primedRef.current) {
      // First successful poll: seed the cursor, don't refetch the ticket.
      primedRef.current = true;
      if (newest) sinceRef.current = newest;
      return;
    }
    if (newest && newest !== sinceRef.current) {
      sinceRef.current = newest;
      void qc.invalidateQueries({ queryKey: qk.ticket(ctx.workspaceId, ticketId) });
    }
  }, [
    dataUpdatedAt,
    errorUpdatedAt,
    isError,
    data,
    qc,
    ctx.workspaceId,
    ticketId,
  ]);

  const settled = dataUpdatedAt !== 0 || errorUpdatedAt !== 0;
  const state: "connecting" | "open" | "error" = !settled
    ? "connecting"
    : isError || data == null
      ? "error"
      : "open";

  const dotClass =
    state === "open"
      ? "bg-success live-pulse"
      : state === "error"
        ? "bg-warning"
        : "bg-muted-foreground";

  const textClass =
    state === "open"
      ? "text-success"
      : state === "error"
        ? "text-warning-foreground"
        : "text-muted-foreground";

  const paused = isPaused(failures);

  return (
    <span className="inline-flex items-center gap-2">
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-0.5 text-[0.625rem] font-semibold uppercase tracking-wider",
          textClass,
        )}
        aria-live="polite"
        aria-label={`Live updates ${state}`}
      >
        <span
          className={cn("inline-block size-2 rounded-full", dotClass)}
          aria-hidden
        />
        LIVE
      </span>
      {paused ? (
        // Several consecutive poll failures (U11): say so visibly instead of
        // leaving only the amber dot. "Reload" here is a soft SPA retry —
        // refetch the ticket + events rather than a full page reload.
        <span className="inline-flex items-center gap-1 text-xs font-medium text-warning-foreground">
          Updates paused —{" "}
          <button
            type="button"
            onClick={() => {
              failuresRef.current = 0;
              setFailures(0);
              void qc.invalidateQueries({
                queryKey: qk.ticket(ctx.workspaceId, ticketId),
              });
              void query.refetch();
            }}
            className="underline underline-offset-2 hover:no-underline"
          >
            reload
          </button>
        </span>
      ) : null}
    </span>
  );
}
