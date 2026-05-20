"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { cn } from "@/lib/utils";

interface Props {
  readonly caseId: string;
}

export default function CaseLiveBoundary({ caseId }: Props) {
  const router = useRouter();
  const [state, setState] = useState<"connecting" | "open" | "error">(
    "connecting",
  );

  useEffect(() => {
    const source = new EventSource(`/api/cases/${caseId}/events`);

    source.onopen = () => setState("open");
    source.onmessage = () => {
      router.refresh();
    };
    source.onerror = () => {
      setState("error");
    };

    return () => {
      source.close();
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
