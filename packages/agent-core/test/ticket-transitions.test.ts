import { describe, expect, it } from "vitest";
import {
  TICKET_STATUSES,
  MERCHANT_SETTABLE_STATUSES,
  allowedManualStatusTargets,
  isMerchantSettableStatus,
  isStatusTransitionAllowed,
  primaryWaitStatus,
} from "../src/index.js";

// Audit L1 — master-plan §10 claims "the state machine guards every
// status transition", but no transition matrix existed: any from→to
// write was accepted, letting the runtime resolve a ticket a manager had
// just taken over (and letting the LLM set any status via
// ticket.update_status).

describe("isStatusTransitionAllowed", () => {
  it("same-status transitions are always allowed (idempotent writes)", () => {
    for (const s of TICKET_STATUSES) {
      expect(isStatusTransitionAllowed(s, s)).toBe(true);
    }
  });

  it("a human-takeover park can only be exited via resume or failure", () => {
    expect(isStatusTransitionAllowed("human_takeover", "in_progress")).toBe(
      true,
    );
    expect(isStatusTransitionAllowed("human_takeover", "failed")).toBe(true);
    // The L17/takeover race: the agent must never resolve (or re-park)
    // a ticket a person owns.
    expect(isStatusTransitionAllowed("human_takeover", "resolved")).toBe(
      false,
    );
    expect(
      isStatusTransitionAllowed("human_takeover", "waiting_for_approval"),
    ).toBe(false);
    expect(
      isStatusTransitionAllowed("human_takeover", "waiting_for_customer"),
    ).toBe(false);
  });

  it("resolved tickets can reopen or archive but never flip to failed", () => {
    expect(isStatusTransitionAllowed("resolved", "in_progress")).toBe(true);
    expect(isStatusTransitionAllowed("resolved", "waiting_for_approval")).toBe(
      true,
    );
    expect(isStatusTransitionAllowed("resolved", "human_takeover")).toBe(true);
    expect(isStatusTransitionAllowed("resolved", "archived")).toBe(true);
    expect(isStatusTransitionAllowed("resolved", "failed")).toBe(false);
  });

  it("archived tickets can reopen but never become failed or resolved again", () => {
    expect(isStatusTransitionAllowed("archived", "in_progress")).toBe(true);
    expect(isStatusTransitionAllowed("archived", "waiting_for_customer")).toBe(
      true,
    );
    expect(isStatusTransitionAllowed("archived", "human_takeover")).toBe(true);
    expect(isStatusTransitionAllowed("archived", "failed")).toBe(false);
    expect(isStatusTransitionAllowed("archived", "resolved")).toBe(false);
  });

  it("failed tickets can only be reopened or handed to a human", () => {
    expect(isStatusTransitionAllowed("failed", "in_progress")).toBe(true);
    // Reopen-to-waiting: a manual reopen parks the ticket until the
    // customer's next message rather than faking an active in_progress.
    expect(isStatusTransitionAllowed("failed", "waiting_for_customer")).toBe(
      true,
    );
    expect(isStatusTransitionAllowed("failed", "human_takeover")).toBe(true);
    expect(isStatusTransitionAllowed("failed", "resolved")).toBe(false);
    expect(isStatusTransitionAllowed("failed", "waiting_for_approval")).toBe(
      false,
    );
  });

  it("active statuses move freely (the agent loop owns them)", () => {
    for (const from of [
      "new",
      "triaging",
      "in_progress",
      "waiting_for_customer",
      "waiting_for_fulfillment_operator",
      "waiting_for_approval",
      "approved_action_running",
    ] as const) {
      expect(isStatusTransitionAllowed(from, "resolved")).toBe(true);
      expect(isStatusTransitionAllowed(from, "human_takeover")).toBe(true);
    }
  });

  it("only resolved tickets may enter archived (retention is post-resolution)", () => {
    expect(isStatusTransitionAllowed("resolved", "archived")).toBe(true);
    for (const from of [
      "new",
      "triaging",
      "in_progress",
      "waiting_for_customer",
      "waiting_for_fulfillment_operator",
      "waiting_for_approval",
      "approved_action_running",
      "human_takeover",
      "failed",
    ] as const) {
      expect(isStatusTransitionAllowed(from, "archived")).toBe(false);
    }
  });
});

// The merchant-facing "change status manually" feature: a curated subset of
// statuses a person may set by hand, always re-checked against the state
// machine so the manual control never bypasses §10.
describe("MERCHANT_SETTABLE_STATUSES / allowedManualStatusTargets", () => {
  it("only offers human-meaningful lifecycle states (never agent-internal ones)", () => {
    expect([...MERCHANT_SETTABLE_STATUSES].sort()).toEqual(
      ["archived", "failed", "resolved", "waiting_for_customer"].sort(),
    );
    // in_progress is agent-owned too: nothing ticks on a manual status write,
    // so a hand-set in_progress would just fake the "processing" UI. A person
    // reopens to waiting_for_customer; "Retry" actually runs the agent.
    for (const internal of [
      "new",
      "triaging",
      "in_progress",
      "approved_action_running",
      "waiting_for_fulfillment_operator",
      "waiting_for_approval",
      "human_takeover",
    ] as const) {
      expect(isMerchantSettableStatus(internal)).toBe(false);
    }
  });

  it("isMerchantSettableStatus accepts only the curated set", () => {
    expect(isMerchantSettableStatus("resolved")).toBe(true);
    expect(isMerchantSettableStatus("waiting_for_customer")).toBe(true);
    expect(isMerchantSettableStatus("not_a_status")).toBe(false);
  });

  it("an active ticket can be closed (resolved/failed) or parked on the customer", () => {
    expect([...allowedManualStatusTargets("in_progress")].sort()).toEqual(
      ["failed", "resolved", "waiting_for_customer"].sort(),
    );
  });

  it("a resolved ticket can be reopened-to-waiting or archived but never manually marked failed", () => {
    const targets = allowedManualStatusTargets("resolved");
    // Reopen lands on waiting_for_customer — never a fake in_progress.
    expect(targets).toContain("waiting_for_customer");
    expect(targets).not.toContain("in_progress");
    // "Archive now" skips the 30-day retention wait.
    expect(targets).toContain("archived");
    // §10: resolved never flips to failed.
    expect(targets).not.toContain("failed");
    // Never offers the current status as a target.
    expect(targets).not.toContain("resolved");
  });

  it("archive is only offered on resolved tickets", () => {
    for (const from of [
      "new",
      "in_progress",
      "waiting_for_customer",
      "human_takeover",
      "failed",
      "archived",
    ] as const) {
      expect(allowedManualStatusTargets(from)).not.toContain("archived");
    }
  });

  it("a taken-over ticket can only be closed-as-failed (hand-back has its own flow)", () => {
    expect(allowedManualStatusTargets("human_takeover")).toEqual(["failed"]);
  });

  it("a failed ticket reopens to waiting_for_customer (never a fake in_progress)", () => {
    expect(allowedManualStatusTargets("failed")).toEqual(["waiting_for_customer"]);
  });

  it("every offered target is a legal transition from its source", () => {
    for (const from of TICKET_STATUSES) {
      for (const to of allowedManualStatusTargets(from)) {
        expect(isStatusTransitionAllowed(from, to)).toBe(true);
        expect(to).not.toBe(from);
        expect(isMerchantSettableStatus(to)).toBe(true);
      }
    }
  });
});

// A ticket can be waiting on approval AND on a fulfillmentOperator at once (both facts are
// row-derived: pending approval rows, open escalation rows). The single
// tickets.status carries the PRIMARY wait — approval wins because the merchant
// is the next unblocker; the fulfillmentOperator wait is passive (the open escalation row
// + notify outbox carry it). This helper is the one place that precedence
// lives.
describe("primaryWaitStatus", () => {
  it("approval wins when both waits hold", () => {
    expect(
      primaryWaitStatus({ approvalPending: true, fulfillmentOperatorOpen: true }),
    ).toBe("waiting_for_approval");
  });

  it("approval alone parks on approval", () => {
    expect(
      primaryWaitStatus({ approvalPending: true, fulfillmentOperatorOpen: false }),
    ).toBe("waiting_for_approval");
  });

  it("fulfillmentOperator alone parks on the fulfillmentOperator", () => {
    expect(
      primaryWaitStatus({ approvalPending: false, fulfillmentOperatorOpen: true }),
    ).toBe("waiting_for_fulfillment_operator");
  });

  it("no waits → null (nothing to park on)", () => {
    expect(
      primaryWaitStatus({ approvalPending: false, fulfillmentOperatorOpen: false }),
    ).toBeNull();
  });
});
