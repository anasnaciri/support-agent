// Maps a case-page mutation's discriminated outcome (`{ kind }`) to the toast
// copy the Next app showed as a post-redirect banner. Pure + tested; the case
// page's useMutation onSuccess fires `toast[tone](text)`. Approve/reject carry
// an extra `action` ("approve" | "reject") because the success copy differs.

export type FeedbackTone = "success" | "info" | "warning";

export interface ActionFeedback {
  readonly tone: FeedbackTone;
  readonly text: string;
}

export type CaseAction =
  | "takeover"
  | "resume"
  | "retry"
  | "retrySend"
  | "resendApproval"
  | "setStatus"
  | "resolve"
  | "issueRefund"
  | "reply";

const FEEDBACK: Record<CaseAction, Record<string, ActionFeedback>> = {
  takeover: {
    taken_over: {
      tone: "success",
      text: "You've taken over this case. The agent will not act on it further; pending approvals were canceled.",
    },
    already_terminal: {
      tone: "info",
      text: "This case was already in a terminal state — no change.",
    },
  },
  resume: {
    resumed: {
      tone: "success",
      text: "Handed back to the agent. It will resume on the customer's next reply.",
    },
    not_in_takeover: {
      tone: "info",
      text: "This case wasn't under human takeover — no change.",
    },
  },
  retry: {
    retried: {
      tone: "success",
      text: "Handed back to the agent — it's retrying now. New activity will appear in the timeline shortly.",
    },
    resumed_no_tick: {
      tone: "warning",
      text: "Handed back to the agent, but the retry couldn't be queued. It will resume on the customer's next reply.",
    },
    not_in_takeover: {
      tone: "info",
      text: "This case wasn't under human takeover — no change.",
    },
  },
  retrySend: {
    queued: {
      tone: "success",
      text: "Re-sending the reply now. If it goes through, the case resolves automatically; if it fails again it stays here.",
    },
    no_failed_delivery: {
      tone: "info",
      text: "There's no failed reply to re-send on this case — no change.",
    },
  },
  setStatus: {
    updated: {
      tone: "success",
      text: "Case status updated. Any pending approvals on the case were canceled.",
    },
    unchanged: {
      tone: "info",
      text: "That's already the case's status — no change.",
    },
    invalid_status: {
      tone: "warning",
      text: "That status can't be set by hand.",
    },
    transition_not_allowed: {
      tone: "warning",
      text: "That status change isn't allowed from where this case is now.",
    },
  },
  resolve: {
    resolved: { tone: "success", text: "Case resolved." },
    case_not_found: {
      tone: "warning",
      text: "Couldn't find that case to resolve.",
    },
  },
  issueRefund: {
    issued: {
      tone: "success",
      text: "Refund issued. The customer is notified by Shopify and the refund is recorded on the case.",
    },
    already_refunded: {
      tone: "info",
      text: "That order is already fully refunded — nothing more to issue.",
    },
    order_not_found: {
      tone: "warning",
      text: "Couldn't find the order to refund. Open it in Shopify to issue the refund there.",
    },
    currency_mismatch: {
      tone: "warning",
      text: "The refund currency doesn't match the order's — issue this refund in Shopify instead.",
    },
    refund_failed: {
      tone: "warning",
      text: "Shopify rejected the refund. No money moved — try again or issue it in Shopify.",
    },
    invalid_amount: { tone: "warning", text: "That refund amount isn't valid." },
  },
  resendApproval: {
    resent: {
      tone: "success",
      text: "The approved reply was sent to the customer. The case stays with you — resolve it when you're done.",
    },
    nothing_to_resend: {
      tone: "info",
      text: "There's no approved reply waiting to be sent on this case — no change.",
    },
    not_in_takeover: {
      tone: "info",
      text: "You can only resend an approved reply while you've taken over the case.",
    },
    send_failed: {
      tone: "warning",
      text: "The reply couldn't be sent. Check the connected mailbox and try again.",
    },
    case_not_found: {
      tone: "warning",
      text: "Couldn't find that case to resend on.",
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
      text: "You can only send a manual reply while you've taken over the case.",
    },
    no_thread: {
      tone: "warning",
      text: "This case has no connected email thread to reply on.",
    },
  },
};

const GENERIC_ERROR: ActionFeedback = {
  tone: "warning",
  text: "Something went wrong. Please try again.",
};

/** Toast copy for a case action's outcome; a generic error for unknown/error kinds. */
export const caseActionFeedback = (
  action: CaseAction,
  kind: string,
): ActionFeedback => FEEDBACK[action][kind] ?? GENERIC_ERROR;

/** A whole-case approval BUNDLE decision (approve all / reject remaining). */
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
              ? `Approved ${n} action${n === 1 ? "" : "s"} — they'll run in order.`
              : "Approved — the queued actions will run in order.",
        }
      : {
          tone: "success",
          text: "Rejected the remaining actions. The case moved to human takeover.",
        };
  }
  if (kind === "no_pending") {
    return {
      tone: "info",
      text: "No queued actions were left to decide — no change.",
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
          text: "Rejected. The case is now in human takeover.",
        };
  }
  if (kind === "already_decided") {
    return {
      tone: "info",
      text: "This approval had already been decided — no change.",
    };
  }
  if (kind === "approval_not_found") {
    return { tone: "warning", text: "Approval not found." };
  }
  return GENERIC_ERROR;
};
