import { describe, expect, it } from "vitest";
import type { DomainEvent } from "@support-agent/agent-core";
import type { ResumeOutcome } from "@support-agent/db";
import { retryCaseNow } from "../case-retry.js";

const recorder = () => {
  const events: DomainEvent[] = [];
  return {
    events,
    publish: async (event: DomainEvent) => {
      events.push(event);
    },
  };
};

describe("retryCaseNow — resume + immediate case.resumed tick", () => {
  it("resumes the case and publishes case.resumed with the dashboard trigger", async () => {
    const { events, publish } = recorder();
    const outcome = await retryCaseNow({
      caseId: "c-1",
      resume: async (): Promise<ResumeOutcome> => ({
        kind: "resumed",
        toStatus: "in_progress",
      }),
      publish,
    });
    expect(outcome).toEqual({ kind: "retried", toStatus: "in_progress" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "case.resumed",
      caseId: "c-1",
      trigger: "dashboard_retry",
    });
  });

  it("publishes the full-retry trigger when fromTriage is set", async () => {
    const { events, publish } = recorder();
    const outcome = await retryCaseNow({
      caseId: "c-2",
      fromTriage: true,
      resume: async (): Promise<ResumeOutcome> => ({
        kind: "resumed",
        toStatus: "in_progress",
      }),
      publish,
    });
    expect(outcome).toEqual({ kind: "retried", toStatus: "in_progress" });
    expect(events[0]).toMatchObject({
      type: "case.resumed",
      caseId: "c-2",
      // Distinct trigger so the runtime + audit can tell a from-triage
      // restart apart from a resume-the-bound-agent retry.
      trigger: "dashboard_full_retry",
    });
  });

  it("passes case_not_found through without publishing", async () => {
    const { events, publish } = recorder();
    const outcome = await retryCaseNow({
      caseId: "c-404",
      resume: async (): Promise<ResumeOutcome> => ({ kind: "case_not_found" }),
      publish,
    });
    expect(outcome).toEqual({ kind: "case_not_found" });
    expect(events).toHaveLength(0);
  });

  it("passes not_in_takeover through without publishing", async () => {
    const { events, publish } = recorder();
    const outcome = await retryCaseNow({
      caseId: "c-1",
      resume: async (): Promise<ResumeOutcome> => ({
        kind: "not_in_takeover",
        status: "resolved",
      }),
      publish,
    });
    expect(outcome).toEqual({ kind: "not_in_takeover", status: "resolved" });
    expect(events).toHaveLength(0);
  });

  it("reports resumed_no_tick when the publish fails AFTER the status flip", async () => {
    // The transition already committed — the UI must not pretend nothing
    // happened, and must not claim a tick is coming either.
    const outcome = await retryCaseNow({
      caseId: "c-1",
      resume: async (): Promise<ResumeOutcome> => ({
        kind: "resumed",
        toStatus: "in_progress",
      }),
      publish: async () => {
        throw new Error("pg-boss unavailable");
      },
    });
    expect(outcome).toEqual({ kind: "resumed_no_tick", toStatus: "in_progress" });
  });
});
