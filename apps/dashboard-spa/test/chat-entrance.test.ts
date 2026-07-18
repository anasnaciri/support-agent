import { describe, expect, it } from "vitest";

import { classifyEntrances } from "../lib/chat-entrance.js";
import { OPTIMISTIC_MESSAGE_ID_PREFIX } from "../lib/optimistic-reply.js";

const msg = (id: string, direction: "inbound" | "outbound") => ({
  id,
  direction,
});

const optimisticId = `${OPTIMISTIC_MESSAGE_ID_PREFIX}1751900000000`;

describe("classifyEntrances", () => {
  it("never animates the initial render (prevIds is null)", () => {
    const entrances = classifyEntrances(null, [
      msg("m1", "inbound"),
      msg("m2", "outbound"),
    ]);
    expect(entrances.size).toBe(0);
  });

  it("leaves already-present messages alone", () => {
    const entrances = classifyEntrances(
      ["m1", "m2"],
      [msg("m1", "inbound"), msg("m2", "outbound")],
    );
    expect(entrances.size).toBe(0);
  });

  it("rises a newly arrived inbound message", () => {
    const entrances = classifyEntrances(
      ["m1"],
      [msg("m1", "inbound"), msg("m3", "inbound")],
    );
    expect(entrances.get("m3")).toBe("rise");
  });

  it("rises a newly appended optimistic reply", () => {
    const entrances = classifyEntrances(
      ["m1"],
      [msg("m1", "inbound"), msg(optimisticId, "outbound")],
    );
    expect(entrances.get(optimisticId)).toBe("rise");
  });

  it("settles the outbound message that replaces a disappeared optimistic one", () => {
    const entrances = classifyEntrances(
      ["m1", optimisticId],
      [msg("m1", "inbound"), msg("m4", "outbound")],
    );
    // The confirmation swap: same bubble, real id — fade to full opacity in
    // place instead of rising a second time.
    expect(entrances.get("m4")).toBe("settle");
  });

  it("still rises an inbound message that lands in the same refetch as a confirmation swap", () => {
    const entrances = classifyEntrances(
      ["m1", optimisticId],
      [msg("m1", "inbound"), msg("m4", "outbound"), msg("m5", "inbound")],
    );
    expect(entrances.get("m4")).toBe("settle");
    expect(entrances.get("m5")).toBe("rise");
  });

  it("rises an outbound message when no optimistic reply disappeared (agent sent it)", () => {
    const entrances = classifyEntrances(
      ["m1"],
      [msg("m1", "inbound"), msg("m6", "outbound")],
    );
    expect(entrances.get("m6")).toBe("rise");
  });

  it("rises a fresh optimistic reply even while an older one is being confirmed", () => {
    const newerOptimistic = `${OPTIMISTIC_MESSAGE_ID_PREFIX}1751900009999`;
    const entrances = classifyEntrances(
      ["m1", optimisticId],
      [msg("m1", "inbound"), msg("m4", "outbound"), msg(newerOptimistic, "outbound")],
    );
    expect(entrances.get("m4")).toBe("settle");
    expect(entrances.get(newerOptimistic)).toBe("rise");
  });
});
