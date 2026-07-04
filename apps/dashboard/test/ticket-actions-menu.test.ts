import { describe, expect, it } from "vitest";

import { ticketActionMenuItems } from "../app/tickets/[id]/ticket-actions-menu";

describe("ticketActionMenuItems", () => {
  it("is empty when the ticket can't be resumed", () => {
    expect(ticketActionMenuItems({ canResume: false })).toEqual([]);
  });

  it("offers both retry shapes while under human takeover (canResume)", () => {
    const items = ticketActionMenuItems({ canResume: true });
    // Retry the bound specialist's last step, OR restart from triage so the
    // agent re-classifies + re-routes from scratch.
    expect(items.map((i) => i.key)).toEqual(["retryNow", "retryFromTriage"]);
    expect(items[0]).toMatchObject({
      key: "retryNow",
      label: "Retry last step",
      pendingLabel: "Retrying…",
    });
    expect(items[1]).toMatchObject({
      key: "retryFromTriage",
      label: "Restart from triage",
      pendingLabel: "Restarting…",
    });
  });
});
