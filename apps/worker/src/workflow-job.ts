import type { WorkflowResult } from "@support-agent/agent-core";

/**
 * Worker-side settlement of a tick's WorkflowResult (audit C1).
 *
 * The runtime returns `Failed retryable:true` for transient errors (LLM
 * provider 5xx/429, network, DB hiccups). The worker must surface those as a
 * thrown error so pg-boss applies its retry policy (backoff, retryLimit) —
 * completing the job would silently drop the event and strand the ticket.
 * Everything else — terminal results, pauses, and deterministic
 * non-retryable failures — completes the job.
 */
export type WorkflowSettlement =
  | { readonly kind: "complete" }
  | { readonly kind: "retry"; readonly reason: string };

export const settleWorkflowResult = (
  result: WorkflowResult,
): WorkflowSettlement =>
  result.type === "Failed" && result.retryable
    ? { kind: "retry", reason: result.reason }
    : { kind: "complete" };
