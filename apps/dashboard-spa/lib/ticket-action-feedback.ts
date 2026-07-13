// Maps a ticket-page mutation's discriminated outcome (`{ kind }`) to the toast
// copy the Next app showed as a post-redirect banner. Pure + tested; the ticket
// page's useMutation onSuccess fires `toast[tone](text)`. Approve/reject carry
// an extra `action` ("approve" | "reject") because the success copy differs.

export type FeedbackTone = "success" | "info" | "warning";

export interface ActionFeedback {
  readonly tone: FeedbackTone;
  readonly text: string;
}

export type TicketAction =
  | "takeover"
  | "resume"
  | "retry"
  | "retrySend"
  | "resendApproval"
  | "setStatus"
  | "resolve"
  | "issueRefund"
  | "cancelOrder"
  | "escalateFulfillmentOperator"
  | "reply";

const FEEDBACK: Record<TicketAction, Record<string, ActionFeedback>> = {
  takeover: {
    taken_over: {
      tone: "success",
      text: "You've taken over this ticket. The agent will not act on it further; pending approvals were canceled.",
    },
    already_terminal: {
      tone: "info",
      text: "This ticket was already in a terminal state. No change.",
    },
  },
  resume: {
    resumed: {
      tone: "success",
      text: "Handed back to the agent. It will resume on the customer's next reply.",
    },
    not_in_takeover: {
      tone: "info",
      text: "This ticket wasn't under human takeover. No change.",
    },
  },
  retry: {
    retried: {
      tone: "success",
      text: "Handed back to the agent. It's retrying now. New activity will appear in the timeline shortly.",
    },
    resumed_no_tick: {
      tone: "warning",
      text: "Handed back to the agent, but the retry couldn't be queued. It will resume on the customer's next reply.",
    },
    not_in_takeover: {
      tone: "info",
      text: "This ticket wasn't under human takeover. No change.",
    },
  },
  retrySend: {
    queued: {
      tone: "success",
      text: "Re-sending the reply now. If it goes through, the ticket resolves automatically; if it fails again it stays here.",
    },
    no_failed_delivery: {
      tone: "info",
      text: "There's no failed reply to re-send on this ticket. No change.",
    },
  },
  setStatus: {
    updated: {
      tone: "success",
      text: "Ticket status updated. Any pending approvals on the ticket were canceled.",
    },
    unchanged: {
      tone: "info",
      text: "That's already the ticket's status. No change.",
    },
    invalid_status: {
      tone: "warning",
      text: "That status can't be set by hand.",
    },
    transition_not_allowed: {
      tone: "warning",
      text: "That status change isn't allowed from where this ticket is now.",
    },
  },
  resolve: {
    resolved: { tone: "success", text: "Ticket resolved." },
    ticket_not_found: {
      tone: "warning",
      text: "Couldn't find that ticket to resolve.",
    },
  },
  issueRefund: {
    issued: {
      tone: "success",
      text: "Refund issued. The customer is notified by Shopify and the refund is recorded on the ticket.",
    },
    already_refunded: {
      tone: "info",
      text: "That order is already fully refunded. Nothing more to issue.",
    },
    order_not_found: {
      tone: "warning",
      text: "Couldn't find the order to refund. Open it in Shopify to issue the refund there.",
    },
    currency_mismatch: {
      tone: "warning",
      text: "The refund currency doesn't match the order's. Issue this refund in Shopify instead.",
    },
    refund_failed: {
      tone: "warning",
      text: "Shopify rejected the refund. No money moved. Try again or issue it in Shopify.",
    },
    invalid_amount: { tone: "warning", text: "That refund amount isn't valid." },
  },
  cancelOrder: {
    cancelled: {
      tone: "success",
      text: "Order cancelled. Shopify processes the refund and restock in the background, so the order may take a moment to update.",
    },
    already_cancelled: {
      tone: "info",
      text: "That order is already cancelled. No change.",
    },
    order_not_found: {
      tone: "warning",
      text: "Couldn't find the order to cancel. Open it in Shopify to cancel it there.",
    },
    cancel_failed: {
      tone: "warning",
      text: "Shopify rejected the cancellation. Nothing was cancelled and no money moved. An order that has shipped has to be refunded instead.",
    },
    invalid_reason: {
      tone: "warning",
      text: "That cancellation reason isn't valid.",
    },
    ticket_not_found: {
      tone: "warning",
      text: "Couldn't find that ticket to cancel on.",
    },
  },
  escalateFulfillmentOperator: {
    escalated: {
      tone: "success",
      text: "Escalated to your fulfillment partner. The ticket waits for their update; they've been sent a portal link.",
    },
    no_fulfillment_operator: {
      tone: "warning",
      text: "No fulfillment partner is set up for this workspace. Add one in Settings → Fulfillment partners first.",
    },
    already_escalated: {
      tone: "info",
      text: "This ticket is already with your fulfillment partner. No change.",
    },
    transition_not_allowed: {
      tone: "warning",
      text: "This ticket can't be escalated from where it is now.",
    },
    ticket_not_found: {
      tone: "warning",
      text: "Couldn't find that ticket to escalate.",
    },
  },
  resendApproval: {
    resent: {
      tone: "success",
      text: "The approved reply was sent to the customer. The ticket stays with you; resolve it when you're done.",
    },
    nothing_to_resend: {
      tone: "info",
      text: "There's no approved reply waiting to be sent on this ticket. No change.",
    },
    not_in_takeover: {
      tone: "info",
      text: "You can only resend an approved reply while you've taken over the ticket.",
    },
    send_failed: {
      tone: "warning",
      text: "The reply couldn't be sent. Check the connected mailbox and try again.",
    },
    ticket_not_found: {
      tone: "warning",
      text: "Couldn't find that ticket to resend on.",
    },
  },
  reply: {
    sent: { tone: "success", text: "Your reply was sent to the customer." },
    send_failed: {
      tone: "warning",
      text: "The reply couldn't be sent. Check the connected mailbox and try again.",
    },
    empty_body: { tone: "warning", text: "Write a message before sending." },
    not_in_takeover: {
      tone: "info",
      text: "You can only send a manual reply while you've taken over the ticket.",
    },
    no_thread: {
      tone: "warning",
      text: "This ticket has no connected email thread to reply on.",
    },
  },
};

const GENERIC_ERROR: ActionFeedback = {
  tone: "warning",
  text: "Something went wrong. Please try again.",
};

/** Toast copy for a ticket action's outcome; a generic error for unknown/error kinds. */
export const ticketActionFeedback = (
  action: TicketAction,
  kind: string,
): ActionFeedback => FEEDBACK[action][kind] ?? GENERIC_ERROR;

/** A whole-ticket approval BUNDLE decision (approve all / reject remaining). */
export const bundleDecisionFeedback = (
  action: "approve" | "reject",
  kind: string,
  count?: number,
): ActionFeedback => {
  if (kind === "decided") {
    const n = typeof count === "number" ? count : 0;
    return action === "approve"
      ? {
          tone: "success",
          text:
            n > 0
              ? `Approved ${n} action${n === 1 ? "" : "s"}. They'll run in order.`
              : "Approved. The queued actions will run in order.",
        }
      : {
          tone: "success",
          text: "Rejected the remaining actions. The ticket moved to human takeover.",
        };
  }
  if (kind === "no_pending") {
    return {
      tone: "info",
      text: "No queued actions were left to decide. No change.",
    };
  }
  return GENERIC_ERROR;
};

/** Approve/reject success copy differs; other kinds mirror the shared map. */
export const approvalDecisionFeedback = (
  action: "approve" | "reject",
  kind: string,
): ActionFeedback => {
  if (kind === "decided") {
    return action === "approve"
      ? {
          tone: "success",
          text: "Approved. The customer reply will be sent in a moment.",
        }
      : {
          tone: "success",
          text: "Rejected. The ticket is now in human takeover.",
        };
  }
  if (kind === "already_decided") {
    return {
      tone: "info",
      text: "This approval had already been decided. No change.",
    };
  }
  if (kind === "approval_not_found") {
    return { tone: "warning", text: "Approval not found." };
  }
  return GENERIC_ERROR;
};
