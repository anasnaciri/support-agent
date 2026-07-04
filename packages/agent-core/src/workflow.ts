import type { ApprovalId } from "./ids.js";

export type WorkflowResult =
  | { readonly type: "Completed" }
  | { readonly type: "PausedWaitingForCustomer" }
  | {
      readonly type: "PausedWaitingForApproval";
      readonly approvalId: ApprovalId;
    }
  | { readonly type: "PausedWaitingForSupplier" }
  // A manager took the case over from the dashboard. The runtime holds
  // every event (customer replies, timers) without running the agent until
  // a human hands the case back (which transitions it out of
  // `human_takeover`). Distinct from `HumanTakeoverRequired`, which is the
  // runtime *escalating* a case it could not finish.
  | { readonly type: "PausedForHumanTakeover" }
  | { readonly type: "PausedArchived" }
  | {
      readonly type: "Failed";
      readonly reason: string;
      readonly retryable: boolean;
    }
  | { readonly type: "HumanTakeoverRequired"; readonly reason: string };
