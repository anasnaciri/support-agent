// ============================================================
// Dashboard "Retry now" — resume a taken-over case AND tick the agent
// ============================================================
//
// "Hand back to agent" (resumeCase) only flips `human_takeover` →
// `in_progress`; the agent then waits for the customer's next message.
// After a `max_turns_exceeded` / retries-exhausted escalation that's the
// wrong shape — the customer already wrote, the agent just failed. Retry
// composes the same resume with an immediate `case.resumed` workflow
// event so the worker runs a tick right away.
//
// Ordering: the status flip commits FIRST. The runtime's takeover guard
// (§2.95) holds every event while the status is `human_takeover`, so
// publishing before the flip would park the very event we just minted.
// If the publish fails after the flip we report `resumed_no_tick` —
// equivalent to a plain hand-back (agent resumes on the next inbound
// message), never a lost case.

import { CaseId, type DomainEvent } from "@support-agent/agent-core";
import type { ResumeOutcome } from "@support-agent/db";

export type RetryOutcome =
  | { readonly kind: "retried"; readonly toStatus: string }
  | { readonly kind: "resumed_no_tick"; readonly toStatus: string }
  | { readonly kind: "case_not_found" }
  | { readonly kind: "not_in_takeover"; readonly status: string };

export interface RetryCaseNowOptions {
  readonly caseId: string;
  /** Runs the status flip (dashboard-writes `resumeCase`) and reports how it went. */
  readonly resume: () => Promise<ResumeOutcome>;
  /** Publishes a workflow event onto `workflow.events`. */
  readonly publish: (event: DomainEvent) => Promise<void>;
}

export const retryCaseNow = async (
  opts: RetryCaseNowOptions,
): Promise<RetryOutcome> => {
  const resumed = await opts.resume();
  if (resumed.kind !== "resumed") return resumed;
  try {
    await opts.publish({
      type: "case.resumed",
      caseId: CaseId(opts.caseId),
      trigger: "dashboard_retry",
    });
    return { kind: "retried", toStatus: resumed.toStatus };
  } catch (cause) {
    // eslint-disable-next-line no-console
    console.error("[dashboard retry] publish failed; case resumed without tick", {
      caseId: opts.caseId,
      cause,
    });
    return { kind: "resumed_no_tick", toStatus: resumed.toStatus };
  }
};
