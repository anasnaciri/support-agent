// Pure logic for the composer's "attach a file already on this ticket" picker.
// The ticket's attachment index (GET /dashboard/tickets/:id/attachments) holds
// files a supplier sent, files the team uploaded on an earlier reply, and
// customer attachments — any of which the manager may want to forward. Kept out
// of ChatComposer so the offer/capacity rules are unit-testable.

import type { TicketAttachmentSummary } from "@support-agent/dashboard-contracts";

/** Merchant-facing name for where a file came from (no schema wording). */
export const attachmentSourceLabel = (
  source: TicketAttachmentSummary["source"],
): string => {
  if (source === "inbound") return "From the customer";
  if (source === "supplier") return "From the supplier";
  return "Uploaded by your team";
};

export interface AttachmentPickerState {
  /** Indexed files not already staged on this message, newest first. */
  readonly available: ReadonlyArray<TicketAttachmentSummary>;
  /** Whether to render the picker at all. */
  readonly show: boolean;
  /** Attachment slots left on this message. */
  readonly remainingSlots: number;
  readonly atCapacity: boolean;
}

/**
 * What the picker offers. Staged files drop out of the list (they're already
 * chips), and the per-message cap is counted against everything staged — fresh
 * uploads included — so picking an existing file can't push the reply past it.
 * At capacity the list still renders, with every row unselectable, rather than
 * vanishing without explanation.
 */
export const attachmentPickerState = (input: {
  readonly index: ReadonlyArray<TicketAttachmentSummary>;
  readonly staged: ReadonlyArray<TicketAttachmentSummary>;
  readonly max: number;
}): AttachmentPickerState => {
  const stagedIds = new Set(input.staged.map((a) => a.id));
  const available = input.index
    .filter((a) => !stagedIds.has(a.id))
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const remainingSlots = Math.max(0, input.max - input.staged.length);
  return {
    available,
    show: available.length > 0,
    remainingSlots,
    atCapacity: remainingSlots === 0,
  };
};
