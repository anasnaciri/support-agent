import type { TicketWaitingOn } from "@support-agent/dashboard-contracts";

export type WaitChipStatus = "waiting_for_supplier" | "waiting_for_approval";

/**
 * Concurrent wait states: a ticket's `status` is the single primary-wait pointer
 * (`primaryWaitStatus` — approval wins), but the ticket can hold BOTH an open
 * approval and an open supplier escalation. Given the status badge + the
 * row-derived `waitingOn`, return the wait facts that hold but are NOT already
 * the status badge — the caller renders each as a second chip. Absent
 * `waitingOn` (an older api) yields no extra chips.
 */
export const extraWaitChips = (
  status: string,
  waitingOn: TicketWaitingOn | undefined,
): ReadonlyArray<WaitChipStatus> => {
  if (!waitingOn) return [];
  const chips: WaitChipStatus[] = [];
  if (waitingOn.supplier && status !== "waiting_for_supplier") {
    chips.push("waiting_for_supplier");
  }
  if (waitingOn.approval && status !== "waiting_for_approval") {
    chips.push("waiting_for_approval");
  }
  return chips;
};
