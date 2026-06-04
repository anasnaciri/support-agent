"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { cn } from "@/lib/utils";

interface Props {
  readonly caseId: string;
  /** Highest audit id at render time; we only refresh on events after it. */
  readonly initialSince: string;
}

const POLL_MS = 2500;

export default function CaseLiveBoundary({ caseId, initialSince }: Props) {
  const router = useRouter();
  const [state, setState] = useState<"connecting" | "open" | "error">(
    "connecting",
  );
  const sinceRef = useRef(initialSince);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const res = await fetch(
          `/api/cases/${caseId}/events?since=${encodeURIComponent(sinceRef.current)}`,
          { cache: "no-store" },
        );
        if (!active) return;
        if (!res.ok) {
          setState("error");
        } else {
          setState("open");
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
        if (active) setState("error");
      } finally {
        if (active) timer = setTimeout(tick, POLL_MS);
      }
    };

    void tick();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [caseId, router]);

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

  return (
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
  );
}
