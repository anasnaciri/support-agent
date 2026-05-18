"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface Props {
  readonly caseId: string;
}

// Subscribes to the SSE stream for this case. On each `data:` event,
// calls `router.refresh()` so the Server Component re-fetches the
// audit timeline + case row. That re-render is what surfaces the new
// activity in the browser — there is no client-side state mirror of
// the timeline.
//
// Why router.refresh and not local-state diffing:
//   - The page already renders everything server-side from Postgres;
//     diffing client-side risks the dashboard showing a different
//     timeline shape than a server-rendered reload would.
//   - Refresh is cheap because RSC streams only the changed segment.
//   - The SSE payload doubles as a tap-on-the-shoulder, not a data
//     source — the server stays the source of truth.
//
// Reconnection: EventSource auto-reconnects on transient network
// errors (using the `retry:` hint from the SSE endpoint, 2s today).
// On hard close we tear down + remount; useEffect cleanup handles it.
//
// Renders an invisible <span> with the connection state so a future
// LIVE indicator can read it via aria-live or a sibling subscription.
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
      // The browser auto-reconnects; we just reflect the state for any
      // observer. Don't close — that would prevent reconnection.
      setState("error");
    };

    return () => {
      source.close();
    };
  }, [caseId, router]);

  return (
    <span
      className="live-indicator"
      data-state={state}
      aria-live="polite"
      aria-label={`Live updates ${state}`}
    >
      <span className="live-dot" aria-hidden="true" />
      <span className="live-label">LIVE</span>
    </span>
  );
}
