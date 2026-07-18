import { describe, expect, it } from "vitest";
import type {
  DashboardConversationMessage,
  TicketConversationThreadResult,
} from "@support-agent/dashboard-contracts";

import {
  confirmPin,
  mergePinnedReplies,
  removePin,
} from "../lib/pinned-replies.js";
import { OPTIMISTIC_MESSAGE_ID_PREFIX } from "../lib/optimistic-reply.js";

const message = (
  id: string,
  direction: "inbound" | "outbound",
  sentAt = "2026-07-18T10:00:00.000Z",
): DashboardConversationMessage => ({
  id,
  direction,
  from: { name: "Jane", email: "jane@example.com" },
  to: [],
  subject: null,
  bodyText: `body of ${id}`,
  sanitizedBodyHtml: null,
  sentAt,
  attachments: [],
});

const available = (
  ...messages: ReadonlyArray<DashboardConversationMessage>
): TicketConversationThreadResult => ({
  status: "available",
  thread: {
    subject: "Order #1016",
    participants: [],
    messages: [...messages],
  },
});

const unavailable: TicketConversationThreadResult = {
  status: "unavailable",
  reason: "no_thread",
};

const optimisticPin = message(
  `${OPTIMISTIC_MESSAGE_ID_PREFIX}1752800000000`,
  "outbound",
  "2026-07-18T10:05:00.000Z",
);

describe("mergePinnedReplies", () => {
  it("returns an unavailable result untouched and absorbs nothing", () => {
    const merge = mergePinnedReplies(unavailable, [optimisticPin]);
    expect(merge.result).toBe(unavailable);
    expect(merge.absorbedPinIds).toEqual([]);
  });

  it("returns the result untouched when there are no pins", () => {
    const result = available(message("m1", "inbound"));
    const merge = mergePinnedReplies(result, []);
    expect(merge.result).toBe(result);
    expect(merge.absorbedPinIds).toEqual([]);
  });

  it("appends a pin the server thread does not have yet", () => {
    const merge = mergePinnedReplies(
      available(message("m1", "inbound")),
      [optimisticPin],
    );
    expect(merge.result.status).toBe("available");
    if (merge.result.status !== "available") return;
    expect(merge.result.thread.messages.map((m) => m.id)).toEqual([
      "m1",
      optimisticPin.id,
    ]);
    expect(merge.absorbedPinIds).toEqual([]);
  });

  it("appends multiple pending pins in sentAt order", () => {
    const older = message("real-a", "outbound", "2026-07-18T10:01:00.000Z");
    const newer = message("real-b", "outbound", "2026-07-18T10:02:00.000Z");
    const merge = mergePinnedReplies(available(message("m1", "inbound")), [
      newer,
      older,
    ]);
    if (merge.result.status !== "available") return;
    expect(merge.result.thread.messages.map((m) => m.id)).toEqual([
      "m1",
      "real-a",
      "real-b",
    ]);
  });

  it("absorbs a pin whose id the server thread now contains, preferring the server copy", () => {
    const serverCopy = {
      ...message("gmail-123", "outbound"),
      sanitizedBodyHtml: "<p>server copy</p>",
    };
    const pin = message("gmail-123", "outbound");
    const merge = mergePinnedReplies(
      available(message("m1", "inbound"), serverCopy),
      [pin],
    );
    if (merge.result.status !== "available") return;
    expect(merge.result.thread.messages).toEqual([
      message("m1", "inbound"),
      serverCopy,
    ]);
    expect(merge.absorbedPinIds).toEqual(["gmail-123"]);
  });

  it("keeps unabsorbed pins while absorbing the rest", () => {
    const merge = mergePinnedReplies(
      available(message("m1", "inbound"), message("gmail-123", "outbound")),
      [message("gmail-123", "outbound"), optimisticPin],
    );
    if (merge.result.status !== "available") return;
    expect(merge.result.thread.messages.map((m) => m.id)).toEqual([
      "m1",
      "gmail-123",
      optimisticPin.id,
    ]);
    expect(merge.absorbedPinIds).toEqual(["gmail-123"]);
  });
});

describe("confirmPin", () => {
  it("swaps the optimistic pin for the confirmed message in place", () => {
    const confirmed = message("gmail-123", "outbound");
    const pins = confirmPin([optimisticPin], optimisticPin.id, confirmed);
    expect(pins).toEqual([confirmed]);
  });

  it("leaves other pins alone", () => {
    const other = message("gmail-999", "outbound");
    const confirmed = message("gmail-123", "outbound");
    const pins = confirmPin(
      [other, optimisticPin],
      optimisticPin.id,
      confirmed,
    );
    expect(pins).toEqual([other, confirmed]);
  });
});

describe("removePin", () => {
  it("drops the failed pin", () => {
    expect(removePin([optimisticPin], optimisticPin.id)).toEqual([]);
  });

  it("is a no-op for an unknown id", () => {
    const pins = [optimisticPin] as const;
    expect(removePin(pins, "nope")).toEqual(pins);
  });
});
