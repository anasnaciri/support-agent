"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { cn } from "@/lib/utils";
import { buildSignInRedirect } from "@/lib/auth-redirect";
import { isPaused, nextFailureCount } from "./live-status";

interface Props {
  readonly ticketId: string;
  /** Highest audit id at render time; we only refresh on events after it. */
  readonly initialSince: string;
}

const POLL_MS = 2500;

export default function TicketLiveBoundary({ ticketId, initialSince }: Props) {
  const router = useRouter();
  const [state, setState] = useState<"connecting" | "open" | "error">(
    "connecting",
  );
  const [failures, setFailures] = useState(0);
  const sinceRef = useRef(initialSince);
  const failuresRef = useRef(0);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const recordResult = (ok: boolean) => {
      failuresRef.current = nextFailureCount(failuresRef.current, ok);
      setFailures(failuresRef.current);
    };

    const tick = async () => {
      try {
        const res = await fetch(
          `/api/tickets/${ticketId}/events?since=${encodeURIComponent(sinceRef.current)}`,
          { cache: "no-store" },
        );
        if (!active) return;
        if (res.status === 401) {
          // Session gone and unrefreshable (U1): stop polling silently and
          // hard-navigate to re-auth, returning to this ticket afterwards.
          active = false;
          window.location.assign(
            buildSignInRedirect(
              `${window.location.pathname}${window.location.search}`,
            ),
          );
          return;
        }
        if (!res.ok) {
          setState("error");
          recordResult(false);
        } else {
          setState("open");
          recordResult(true);
          const data = (await res.json()) as {
            events: ReadonlyArray<{ id: string }>;
          };
          if (data.events.length > 0) {
            sinceRef.current = data.events[data.events.length - 1]!.id;
            // Re-fetch the Server Component so the timeline + panels update.
            router.refresh();
          }
        }
      } catch {
        if (active) {
          setState("error");
          recordResult(false);
        }
      } finally {
        if (active) timer = setTimeout(tick, POLL_MS);
      }
    };

    void tick();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [ticketId, router]);

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
          "inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
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
        // leaving only the amber dot.
        <span className="inline-flex items-center gap-1 text-xs font-medium text-warning-foreground">
          Updates paused —{" "}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="underline underline-offset-2 hover:no-underline"
          >
            reload
          </button>
        </span>
      ) : null}
    </span>
  );
}
