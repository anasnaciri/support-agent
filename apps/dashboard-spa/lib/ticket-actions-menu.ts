// The ticket-page retry dropdown (the ↺ button in the header row). Kept pure +
// tested so the menu's contents stay easy to reason about.

export type TicketActionKey = "retryNow" | "retryFromTriage";

export interface TicketActionMenuItemMeta {
  readonly key: TicketActionKey;
  readonly label: string;
  /** Label swapped in while the action is in flight. */
  readonly pendingLabel: string;
  readonly title: string;
}

export interface TicketActionMenuInput {
  /** True while the ticket is under human takeover (the only state the agent can
   *  be handed back from). */
  readonly canResume: boolean;
}

/**
 * Which actions live in the retry dropdown, given ticket state. Available while
 * the ticket is under human takeover. Two retry shapes:
 *  - "Retry last step" re-runs the ticket's CURRENT agent (the bound specialist).
 *  - "Retry ticket" rebinds the ticket to triage so the agent re-classifies +
 *    re-routes from scratch — use when the routing was wrong.
 */
export const ticketActionMenuItems = ({
  canResume,
}: TicketActionMenuInput): ReadonlyArray<TicketActionMenuItemMeta> => {
  const items: TicketActionMenuItemMeta[] = [];
  if (canResume) {
    items.push({
      key: "retryNow",
      label: "Retry last step",
      pendingLabel: "Retrying…",
      title:
        "Hand the ticket back and re-run the current agent's last step right now",
    });
    items.push({
      key: "retryFromTriage",
      label: "Retry ticket",
      pendingLabel: "Restarting…",
      title:
        "Hand the ticket back and restart - the agent re-classifies and re-routes from scratch",
    });
  }
  return items;
};
