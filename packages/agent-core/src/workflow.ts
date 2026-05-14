import type { ApprovalId } from "./ids.js";

export type WorkflowResult =
  | { readonly type: "Completed" }
  | { readonly type: "PausedWaitingForCustomer" }
  | {
      readonly type: "PausedWaitingForApproval";
      readonly approvalId: ApprovalId;
    }
  | { readonly type: "PausedWaitingForSupplier" }
  | {
      readonly type: "Failed";
      readonly reason: string;
      readonly retryable: boolean;
    }
  | { readonly type: "HumanTakeoverRequired"; readonly reason: string };
