// Tiny pub/sub linking the ticket page's live-event poller to the tickets
// sidebar. TicketLiveBoundary broadcasts when its `?since=` poll sees a new
// audit event; TicketsSidebar subscribes and folds a fresh page 1 into its
// loaded rows in place. The sidebar's rows are hand-rolled client state (not a
// TanStack Query cache entry — see tickets-sidebar-data.ts for why), so query
// invalidation can't reach it; this module is the bridge. Framework-free so it
// stays unit-testable in node.

type Listener = () => void;

const listeners = new Set<Listener>();

/** Subscribe to "some ticket changed" broadcasts; returns the unsubscriber. */
export const subscribeTicketsChanged = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Notify every subscriber. A throwing listener doesn't block the rest. */
export const broadcastTicketsChanged = (): void => {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // Listeners are freshness top-ups — a failure is never load-bearing.
    }
  }
};
