import type {
  DashboardConversationMessage,
  TicketConversationThreadResult,
} from "@support-agent/dashboard-contracts";

// Pinned replies: the manager's in-flight sends, held in page state and merged
// into the server thread at render time — never written into the query cache.
// The cache is refetch-clobbered at exactly the wrong moments (the send's own
// success invalidation races the 2.5s live poll), which made a cache-resident
// optimistic bubble vanish and re-rise. A pin survives every refetch:
//
//   send pressed   → pin the optimistic message (translucent bubble)
//   server said ok → confirmPin swaps in the REAL provider message id
//                    (the bubble settles to full opacity)
//   thread catches up → the merge sees the same id server-side and absorbs the
//                    pin — identical React key, so the hand-off renders nothing
//   send failed    → removePin (bubble leaves, error toast explains)
//
// Both connectors return the same message id from reply() that the thread
// read-back later reports (Gmail message id; IMAP RFC Message-ID), so id
// equality is the absorption test.

export interface ReplyPinHandlers {
  /** Send pressed: show the translucent optimistic bubble. */
  readonly start: (message: DashboardConversationMessage) => void;
  /** Server confirmed: swap the pin to the real message (full opacity). */
  readonly confirm: (
    optimisticId: string,
    confirmed: DashboardConversationMessage,
  ) => void;
  /** Send failed: drop the bubble (the toast carries the explanation). */
  readonly fail: (optimisticId: string) => void;
}

export interface PinnedRepliesMerge {
  readonly result: TicketConversationThreadResult;
  /** Pins the server thread now contains — safe to prune from state. */
  readonly absorbedPinIds: ReadonlyArray<string>;
}

export const mergePinnedReplies = (
  result: TicketConversationThreadResult,
  pins: ReadonlyArray<DashboardConversationMessage>,
): PinnedRepliesMerge => {
  if (result.status !== "available" || pins.length === 0) {
    return { result, absorbedPinIds: [] };
  }
  const threadIds = new Set(result.thread.messages.map((m) => m.id));
  const absorbedPinIds = pins
    .filter((p) => threadIds.has(p.id))
    .map((p) => p.id);
  const pending = pins
    .filter((p) => !threadIds.has(p.id))
    .sort((a, b) => a.sentAt.localeCompare(b.sentAt));
  if (pending.length === 0) return { result, absorbedPinIds };
  return {
    result: {
      status: "available",
      thread: {
        ...result.thread,
        messages: [...result.thread.messages, ...pending],
      },
    },
    absorbedPinIds,
  };
};

export const confirmPin = (
  pins: ReadonlyArray<DashboardConversationMessage>,
  optimisticId: string,
  confirmed: DashboardConversationMessage,
): ReadonlyArray<DashboardConversationMessage> =>
  pins.map((p) => (p.id === optimisticId ? confirmed : p));

export const removePin = (
  pins: ReadonlyArray<DashboardConversationMessage>,
  optimisticId: string,
): ReadonlyArray<DashboardConversationMessage> =>
  pins.filter((p) => p.id !== optimisticId);
