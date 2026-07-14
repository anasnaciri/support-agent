import { ticketStatusLabel } from "./labels";

// Merchant-facing copy for the manual "change status" menu (ticket-page ⋮).
// Kept pure + tested, mirroring ticket-actions-menu.ts. The one contextual
// case: waiting_for_customer is a PARK on a live ticket but a REOPEN on a
// closed one — and either way the copy must say the agent stays quiet until
// the customer's next message, since a manual status write never runs it.

export interface StatusMenuLabel {
  readonly label: string;
  readonly title: string;
}

const CLOSED_STATUSES: ReadonlySet<string> = new Set([
  "resolved",
  "archived",
  "failed",
]);

export const statusMenuLabel = (
  target: string,
  currentStatus: string,
): StatusMenuLabel => {
  if (target === "waiting_for_customer") {
    return CLOSED_STATUSES.has(currentStatus)
      ? {
          label: "Reopen (wait for customer)",
          title:
            "Reopen this ticket parked on the customer — the agent stays quiet until their next message arrives",
        }
      : {
          label: "Mark waiting on customer",
          title: "Park this ticket waiting on the customer",
        };
  }
  if (target === "archived") {
    return {
      label: "Archive now",
      title:
        "Archive this ticket without waiting 30 days; it is deleted 12 months after archiving",
    };
  }
  if (target === "failed") {
    return { label: "Mark as failed", title: "Close this ticket as failed" };
  }
  return {
    label: `Mark as ${ticketStatusLabel(target)}`,
    title: `Set status to ${ticketStatusLabel(target)}`,
  };
};
