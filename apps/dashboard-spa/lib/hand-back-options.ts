// The "Hand back to the agent" dialog's two choices (the ticket-page Bot
// button). Handing a taken-over ticket back never runs the agent by itself,
// so the dialog makes the merchant pick what actually happens next — wait for
// the customer (parked, not "processing") or retry the last step right now.
// Kept pure + tested, mirroring ticket-actions-menu.ts.

export type HandBackChoice = "wait" | "retry";

export interface HandBackOptionMeta {
  readonly key: HandBackChoice;
  readonly label: string;
  readonly description: string;
  /** Label swapped in while the action is in flight. */
  readonly pendingLabel: string;
}

export const HAND_BACK_OPTIONS: ReadonlyArray<HandBackOptionMeta> = [
  {
    key: "wait",
    label: "Wait for the customer's reply",
    description:
      "Nothing runs now. The ticket parks as waiting on the customer, and the agent picks it up when their next message arrives.",
    pendingLabel: "Handing back…",
  },
  {
    key: "retry",
    label: "Retry last step",
    description:
      "The agent re-runs right away with the full conversation, including anything the customer sent while you had the ticket.",
    pendingLabel: "Retrying…",
  },
];
