import { useEffect, useRef, type ReactNode } from "react";

/**
 * The chat scroll viewport that pins to the newest message — like a messaging
 * app. Scrolls to the bottom on mount and whenever `bottomKey` changes (the
 * page re-renders with a new last message after `TicketLiveBoundary` refreshes),
 * so a reply the agent or customer just sent is always in view. The thread is
 * server-rendered and passed as `children`.
 */
export function ChatScrollArea({
  bottomKey,
  className,
  children,
}: {
  /** Changes when the newest message changes — re-triggers the scroll. */
  readonly bottomKey: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [bottomKey]);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
