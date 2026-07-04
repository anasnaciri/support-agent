import { describe, expect, it } from "vitest";
import {
  CASE_STATUSES,
  MERCHANT_SETTABLE_STATUSES,
  allowedManualStatusTargets,
  isMerchantSettableStatus,
  isStatusTransitionAllowed,
  primaryWaitStatus,
} from "../src/index.js";

// Audit L1 — master-plan §10 claims "the state machine guards every
// status transition", but no transition matrix existed: any from→to
// write was accepted, letting the runtime resolve a case a manager had
// just taken over (and letting the LLM set any status via
// case.update_status).

describe("isStatusTransitionAllowed", () => {
  it("same-status transitions are always allowed (idempotent writes)", () => {
    for (const s of CASE_STATUSES) {
      expect(isStatusTransitionAllowed(s, s)).toBe(true);
    }
  });

  it("a human-takeover park can only be exited via resume or failure", () => {
    expect(isStatusTransitionAllowed("human_takeover", "in_progress")).toBe(
      true,
    );
    expect(isStatusTransitionAllowed("human_takeover", "failed")).toBe(true);
    // The L17/takeover race: the agent must never resolve (or re-park)
    // a case a person owns.
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

  it("resolved cases can reopen or archive but never flip to failed", () => {
    expect(isStatusTransitionAllowed("resolved", "in_progress")).toBe(true);
    expect(isStatusTransitionAllowed("resolved", "waiting_for_approval")).toBe(
      true,
    );
    expect(isStatusTransitionAllowed("resolved", "human_takeover")).toBe(true);
    expect(isStatusTransitionAllowed("resolved", "archived")).toBe(true);
    expect(isStatusTransitionAllowed("resolved", "failed")).toBe(false);
  });

  it("archived cases can reopen but never become failed or resolved again", () => {
    expect(isStatusTransitionAllowed("archived", "in_progress")).toBe(true);
    expect(isStatusTransitionAllowed("archived", "waiting_for_customer")).toBe(
      true,
    );
    expect(isStatusTransitionAllowed("archived", "human_takeover")).toBe(true);
    expect(isStatusTransitionAllowed("archived", "failed")).toBe(false);
    expect(isStatusTransitionAllowed("archived", "resolved")).toBe(false);
  });

  it("failed cases can only be reopened or handed to a human", () => {
    expect(isStatusTransitionAllowed("failed", "in_progress")).toBe(true);
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
      "waiting_for_supplier",
      "waiting_for_approval",
      "approved_action_running",
    ] as const) {
      expect(isStatusTransitionAllowed(from, "resolved")).toBe(true);
      expect(isStatusTransitionAllowed(from, "human_takeover")).toBe(true);
    }
  });
});

// The merchant-facing "change status manually" feature: a curated subset of
// statuses a person may set by hand, always re-checked against the state
// machine so the manual control never bypasses §10.
describe("MERCHANT_SETTABLE_STATUSES / allowedManualStatusTargets", () => {
  it("only offers human-meaningful lifecycle states (never agent-internal ones)", () => {
    expect([...MERCHANT_SETTABLE_STATUSES].sort()).toEqual(
      ["failed", "in_progress", "resolved", "waiting_for_customer"].sort(),
    );
    for (const internal of [
      "new",
      "triaging",
      "approved_action_running",
      "waiting_for_supplier",
      "waiting_for_approval",
      "human_takeover",
      "archived",
    ] as const) {
      expect(isMerchantSettableStatus(internal)).toBe(false);
    }
  });

  it("isMerchantSettableStatus accepts only the curated set", () => {
    expect(isMerchantSettableStatus("resolved")).toBe(true);
    expect(isMerchantSettableStatus("in_progress")).toBe(true);
    expect(isMerchantSettableStatus("not_a_status")).toBe(false);
  });

  it("an active case can be closed (resolved/failed) or parked on the customer", () => {
    expect([...allowedManualStatusTargets("in_progress")].sort()).toEqual(
      ["failed", "resolved", "waiting_for_customer"].sort(),
    );
  });

  it("a resolved case can be reopened but never manually marked failed", () => {
    const targets = allowedManualStatusTargets("resolved");
    expect(targets).toContain("in_progress");
    expect(targets).toContain("waiting_for_customer");
    // §10: resolved never flips to failed.
    expect(targets).not.toContain("failed");
    // Never offers the current status as a target.
    expect(targets).not.toContain("resolved");
  });

  it("a taken-over case can be handed back or closed-as-failed (not directly resolved)", () => {
    expect([...allowedManualStatusTargets("human_takeover")].sort()).toEqual(
      ["failed", "in_progress"].sort(),
    );
  });

  it("a failed case can only be reopened to in_progress", () => {
    expect(allowedManualStatusTargets("failed")).toEqual(["in_progress"]);
  });

  it("every offered target is a legal transition from its source", () => {
    for (const from of CASE_STATUSES) {
      for (const to of allowedManualStatusTargets(from)) {
        expect(isStatusTransitionAllowed(from, to)).toBe(true);
        expect(to).not.toBe(from);
        expect(isMerchantSettableStatus(to)).toBe(true);
      }
    }
  });
});

// A case can be waiting on approval AND on a supplier at once (both facts are
// row-derived: pending approval rows, open escalation rows). The single
// cases.status carries the PRIMARY wait — approval wins because the merchant
// is the next unblocker; the supplier wait is passive (the open escalation row
// + notify outbox carry it). This helper is the one place that precedence
// lives.
describe("primaryWaitStatus", () => {
  it("approval wins when both waits hold", () => {
    expect(
      primaryWaitStatus({ approvalPending: true, supplierOpen: true }),
    ).toBe("waiting_for_approval");
  });

  it("approval alone parks on approval", () => {
    expect(
      primaryWaitStatus({ approvalPending: true, supplierOpen: false }),
    ).toBe("waiting_for_approval");
  });

  it("supplier alone parks on the supplier", () => {
    expect(
      primaryWaitStatus({ approvalPending: false, supplierOpen: true }),
    ).toBe("waiting_for_supplier");
  });

  it("no waits → null (nothing to park on)", () => {
    expect(
      primaryWaitStatus({ approvalPending: false, supplierOpen: false }),
    ).toBeNull();
  });
});
