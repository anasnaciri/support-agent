import { isOptimisticMessage } from "./optimistic-reply.js";

// How a chat bubble enters the thread:
//  - "rise": a genuinely new message — slides up from below into place.
//  - "settle": the real outbound message that replaced a just-confirmed
//    optimistic reply. It occupies the exact spot the translucent placeholder
//    held, so it only fades to full opacity — rising again would replay the
//    entrance for a bubble the user already watched arrive.
// Messages absent from the map (including everything on the initial render)
// don't animate at all.
export type MessageEntrance = "rise" | "settle";

export const classifyEntrances = (
  prevIds: ReadonlyArray<string> | null,
  messages: ReadonlyArray<{
    readonly id: string;
    readonly direction: "inbound" | "outbound";
  }>,
): ReadonlyMap<string, MessageEntrance> => {
  const entrances = new Map<string, MessageEntrance>();
  if (prevIds === null) return entrances;

  const prev = new Set(prevIds);
  const currentIds = new Set(messages.map((m) => m.id));
  // A confirmed send: an optimistic placeholder that was in the previous
  // render but is gone now (swapped for the real message by the refetch).
  const optimisticConfirmed = prevIds.some(
    (id) => isOptimisticMessage({ id }) && !currentIds.has(id),
  );

  for (const message of messages) {
    if (prev.has(message.id)) continue;
    const isSwapIn =
      optimisticConfirmed &&
      message.direction === "outbound" &&
      !isOptimisticMessage(message);
    entrances.set(message.id, isSwapIn ? "settle" : "rise");
  }
  return entrances;
};
