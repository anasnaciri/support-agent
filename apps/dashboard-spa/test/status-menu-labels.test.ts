import { describe, expect, it } from "vitest";

import { statusMenuLabel } from "../lib/status-menu-labels";

// The manual status menu's copy. The key case: waiting_for_customer serves
// two intents — parking a live ticket, and REOPENING a closed one — and the
// reopen wording must make clear the agent stays quiet until the customer's
// next message (never "processing").
describe("statusMenuLabel", () => {
  it("labels waiting_for_customer as a reopen on closed tickets", () => {
    for (const from of ["resolved", "archived", "failed"]) {
      const { label, title } = statusMenuLabel("waiting_for_customer", from);
      expect(label).toBe("Reopen (wait for customer)");
      expect(title).toMatch(/next message/i);
    }
  });

  it("labels waiting_for_customer as a park on live tickets", () => {
    const { label } = statusMenuLabel("waiting_for_customer", "in_progress");
    expect(label).toBe("Mark waiting on customer");
  });

  it("keeps the archive and failed copy", () => {
    expect(statusMenuLabel("archived", "resolved").label).toBe("Archive now");
    expect(statusMenuLabel("failed", "in_progress").label).toBe(
      "Mark as failed",
    );
  });

  it("falls back to a humanized label for unknown targets", () => {
    const { label } = statusMenuLabel("some_future_status", "in_progress");
    expect(label).toMatch(/^Mark as /);
  });
});
