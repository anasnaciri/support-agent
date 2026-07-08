import { describe, expect, it } from "vitest";

import {
  broadcastTicketsChanged,
  subscribeTicketsChanged,
} from "../lib/tickets-refresh-signal.js";

describe("tickets refresh signal", () => {
  it("notifies a subscriber on broadcast", () => {
    let calls = 0;
    const unsubscribe = subscribeTicketsChanged(() => {
      calls += 1;
    });
    try {
      broadcastTicketsChanged();
      expect(calls).toBe(1);
      broadcastTicketsChanged();
      expect(calls).toBe(2);
    } finally {
      unsubscribe();
    }
  });

  it("notifies every subscriber, not just the first", () => {
    const seen: string[] = [];
    const un1 = subscribeTicketsChanged(() => seen.push("a"));
    const un2 = subscribeTicketsChanged(() => seen.push("b"));
    try {
      broadcastTicketsChanged();
      expect(seen).toEqual(["a", "b"]);
    } finally {
      un1();
      un2();
    }
  });

  it("stops notifying after unsubscribe", () => {
    let calls = 0;
    const unsubscribe = subscribeTicketsChanged(() => {
      calls += 1;
    });
    unsubscribe();
    broadcastTicketsChanged();
    expect(calls).toBe(0);
  });

  it("a listener that throws does not block the others", () => {
    let calls = 0;
    const unBad = subscribeTicketsChanged(() => {
      throw new Error("boom");
    });
    const unGood = subscribeTicketsChanged(() => {
      calls += 1;
    });
    try {
      expect(() => broadcastTicketsChanged()).not.toThrow();
      expect(calls).toBe(1);
    } finally {
      unBad();
      unGood();
    }
  });

  it("broadcast with no subscribers is a no-op", () => {
    expect(() => broadcastTicketsChanged()).not.toThrow();
  });
});
