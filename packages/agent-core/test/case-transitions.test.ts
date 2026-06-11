import { describe, expect, it } from "vitest";
import {
  CASE_STATUSES,
  isStatusTransitionAllowed,
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

  it("resolved cases can reopen but never flip to failed", () => {
    expect(isStatusTransitionAllowed("resolved", "in_progress")).toBe(true);
    expect(isStatusTransitionAllowed("resolved", "waiting_for_approval")).toBe(
      true,
    );
    expect(isStatusTransitionAllowed("resolved", "human_takeover")).toBe(true);
    expect(isStatusTransitionAllowed("resolved", "failed")).toBe(false);
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
