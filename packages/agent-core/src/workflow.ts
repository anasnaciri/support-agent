import type { ApprovalId } from "./ids.js";

export type WorkflowResult =
  | { readonly type: "Completed" }
  | { readonly type: "PausedWaitingForCustomer" }
  | {
      readonly type: "PausedWaitingForApproval";
      readonly approvalId: ApprovalId;
    }
  | { readonly type: "PausedWaitingForFulfillmentOperator" }
  // A manager took the ticket over from the dashboard. The runtime holds
  // every event (customer replies, timers) without running the agent until
  // a human hands the ticket back (which transitions it out of
  // `human_takeover`). Distinct from `HumanTakeoverRequired`, which is the
  // runtime *escalating* a ticket it could not finish.
  | { readonly type: "PausedForHumanTakeover" }
  | { readonly type: "PausedArchived" }
  | {
      readonly type: "Failed";
      readonly reason: string;
      readonly retryable: boolean;
    }
  | { readonly type: "HumanTakeoverRequired"; readonly reason: string };
