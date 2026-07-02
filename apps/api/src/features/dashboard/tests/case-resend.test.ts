import { describe, expect, it, vi } from "vitest";
import {
  resendApprovedReply,
  type ResendApprovedReplyOptions,
} from "../case-resend.js";

// H9 — one-click resend of an approved reply that was never sent (skipped when
// the case was taken over). Mirrors sendManualReply's DI-core shape: guards, a
// single delivery, best-effort post-send bookkeeping + resolve.

const base = (over: Partial<ResendApprovedReplyOptions> = {}): ResendApprovedReplyOptions => ({
  loadCaseStatus: async () => "human_takeover",
  findResurfaceableApprovalId: async () => "appr-1",
  deliver: async () => ({ id: "msg-1", sentAt: "2026-07-02T00:00:00.000Z" }),
  recordResent: async () => {},
  ...over,
});

describe("resendApprovedReply", () => {
  it("delivers and records on the happy path", async () => {
    const deliver = vi.fn(async () => ({
      id: "msg-9",
      sentAt: "2026-07-02T00:00:00.000Z",
    }));
    const recordResent = vi.fn(async () => {});
    const out = await resendApprovedReply(base({ deliver, recordResent }));
    expect(out).toEqual({
      kind: "resent",
      messageId: "msg-9",
      sentAt: "2026-07-02T00:00:00.000Z",
    });
    expect(deliver).toHaveBeenCalledWith("appr-1");
    expect(recordResent).toHaveBeenCalledWith("appr-1", {
      id: "msg-9",
      sentAt: "2026-07-02T00:00:00.000Z",
    });
  });

  it("returns case_not_found when the case is missing / another tenant", async () => {
    const deliver = vi.fn();
    const out = await resendApprovedReply(
      base({ loadCaseStatus: async () => null, deliver }),
    );
    expect(out).toEqual({ kind: "case_not_found" });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("refuses to resend unless the case is under human_takeover", async () => {
    const deliver = vi.fn();
    const out = await resendApprovedReply(
      base({ loadCaseStatus: async () => "in_progress", deliver }),
    );
    expect(out).toEqual({ kind: "not_in_takeover", status: "in_progress" });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("returns nothing_to_resend when there is no resurfaceable approval", async () => {
    const deliver = vi.fn();
    const out = await resendApprovedReply(
      base({ findResurfaceableApprovalId: async () => null, deliver }),
    );
    expect(out).toEqual({ kind: "nothing_to_resend" });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("reports send_failed when delivery throws (does not record)", async () => {
    const recordResent = vi.fn(async () => {});
    const out = await resendApprovedReply(
      base({
        deliver: async () => {
          throw new Error("smtp down");
        },
        recordResent,
      }),
    );
    expect(out).toEqual({ kind: "send_failed", error: "smtp down" });
    expect(recordResent).not.toHaveBeenCalled();
  });

  it("still reports resent when post-send bookkeeping throws (email already left)", async () => {
    const out = await resendApprovedReply(
      base({
        recordResent: async () => {
          throw new Error("audit write failed");
        },
      }),
    );
    expect(out.kind).toBe("resent");
  });
});
