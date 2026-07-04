// ============================================================
// Dashboard "Reply to customer" — human draft-and-send on a ticket
// ============================================================
//
// While a human is driving a ticket (`human_takeover`), they can draft and send
// a customer-facing reply directly from the ticket page — the agent is paused, so
// no one races the human to the customer's inbox. The reply goes out on the
// SAME connector/thread as the agent's replies (ConversationService.reply), so
// the customer sees a natural continuation and threading stays intact.
//
// This is the dependency-injected orchestration core: pure async over its deps
// so it unit-tests with fakes (no DB, no Effect layer). The HTTP handler wires
// `loadTicket` / `deliver` / `recordSent` to the real services.
//
// Guards (in order): empty body → load the ticket → it must be `human_takeover`
// (we never let a manual reply race the live agent) → it must have a thread +
// mailbox to reply on. Only then do we deliver. A delivery failure is reported
// so the UI can surface it (and NOT claim the customer was reached); post-send
// bookkeeping (outbound message-id index + audit) is best-effort — once the
// email has left, a bookkeeping hiccup must not tell the user the send failed.

export interface ManualReplyTicketView {
  readonly status: string;
  readonly threadId: string | null;
  readonly mailbox: string | null;
}

export interface ManualReplySent {
  readonly id: string;
  /** ISO-8601 send timestamp. */
  readonly sentAt: string;
}

export type ManualReplyOutcome =
  | { readonly kind: "sent"; readonly messageId: string; readonly sentAt: string }
  | { readonly kind: "empty_body" }
  | { readonly kind: "ticket_not_found" }
  | { readonly kind: "not_in_takeover"; readonly status: string }
  | { readonly kind: "no_thread" }
  | { readonly kind: "send_failed"; readonly error: string };

export interface SendManualReplyOptions {
  /** The drafted reply body (trimmed before it reaches the connector). */
  readonly bodyText: string;
  /** Tenant-scoped ticket load; `null` = not found / another tenant. */
  readonly loadTicket: () => Promise<ManualReplyTicketView | null>;
  /** Deliver the reply through the connector. Throws/rejects on failure. */
  readonly deliver: (args: {
    readonly threadId: string;
    readonly mailbox: string;
    readonly bodyText: string;
  }) => Promise<ManualReplySent>;
  /** Best-effort post-send bookkeeping (outbound message-id index + audit). */
  readonly recordSent: (sent: ManualReplySent) => Promise<void>;
}

export const sendManualReply = async (
  opts: SendManualReplyOptions,
): Promise<ManualReplyOutcome> => {
  const bodyText = opts.bodyText.trim();
  if (bodyText.length === 0) return { kind: "empty_body" };

  const ticketView = await opts.loadTicket();
  if (!ticketView) return { kind: "ticket_not_found" };
  if (ticketView.status !== "human_takeover") {
    return { kind: "not_in_takeover", status: ticketView.status };
  }
  if (!ticketView.threadId || !ticketView.mailbox) return { kind: "no_thread" };

  let sent: ManualReplySent;
  try {
    sent = await opts.deliver({
      threadId: ticketView.threadId,
      mailbox: ticketView.mailbox,
      bodyText,
    });
  } catch (cause) {
    return {
      kind: "send_failed",
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }

  try {
    await opts.recordSent(sent);
  } catch (cause) {
    // The email already left — never downgrade a real send to a failure over
    // bookkeeping. Surface it in logs for follow-up.
    // eslint-disable-next-line no-console
    console.error("[manual reply] post-send bookkeeping failed", {
      messageId: sent.id,
      cause,
    });
  }

  return { kind: "sent", messageId: sent.id, sentAt: sent.sentAt };
};
