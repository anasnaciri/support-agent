import { describe, expect, it } from "vitest";
import type { MemberAccess } from "@support-agent/db";
import { decideAuthz, sessionPermissions } from "../src/dashboard-authz.js";

const access = (over: Partial<MemberAccess>): MemberAccess => ({
  assigned: false,
  isOwner: false,
  grantedIds: [],
  anyAssignmentsInWorkspace: false,
  ...over,
});

describe("decideAuthz", () => {
  it("401s when there's no acting user id", () => {
    expect(
      decideAuthz(access({ anyAssignmentsInWorkspace: true }), undefined, "cases.view"),
    ).toEqual({ ok: false, status: 401, error: "missing_user" });
  });

  it("allows everything in open mode (no assignments yet)", () => {
    expect(
      decideAuthz(access({ anyAssignmentsInWorkspace: false }), "u", "settings.llm"),
    ).toEqual({ ok: true });
  });

  it("allows open-mode reads even without an actor id (legacy flows)", () => {
    expect(
      decideAuthz(access({ anyAssignmentsInWorkspace: false }), undefined, "cases.view"),
    ).toEqual({ ok: true });
  });

  it("allows everything for an owner", () => {
    expect(
      decideAuthz(
        access({ anyAssignmentsInWorkspace: true, assigned: true, isOwner: true }),
        "u",
        "members.manage",
      ),
    ).toEqual({ ok: true });
  });

  it("allows a granted permission (and its implications) but denies others", () => {
    const member = access({
      anyAssignmentsInWorkspace: true,
      assigned: true,
      grantedIds: ["cases.reply"],
    });
    expect(decideAuthz(member, "u", "cases.reply")).toEqual({ ok: true });
    // cases.reply implies cases.view
    expect(decideAuthz(member, "u", "cases.view")).toEqual({ ok: true });
    expect(decideAuthz(member, "u", "audit.view")).toEqual({
      ok: false,
      status: 403,
      error: "forbidden",
    });
  });

  it("requires refunds.issue separately from approvals.decide", () => {
    const member = access({
      anyAssignmentsInWorkspace: true,
      assigned: true,
      grantedIds: ["approvals.decide"],
    });
    expect(decideAuthz(member, "u", "approvals.decide")).toEqual({ ok: true });
    expect(decideAuthz(member, "u", "refunds.issue")).toEqual({
      ok: false,
      status: 403,
      error: "forbidden",
    });
  });
});

describe("sessionPermissions", () => {
  it("reports all permissions in open mode, assigned=false", () => {
    const s = sessionPermissions(access({ anyAssignmentsInWorkspace: false }));
    expect(s.isOwner).toBe(false);
    expect(s.assigned).toBe(false);
    expect(s.permissions).toContain("settings.llm");
    expect(s.permissions).toContain("audit.view");
  });

  it("reports a scoped member's expanded permissions", () => {
    const s = sessionPermissions(
      access({
        anyAssignmentsInWorkspace: true,
        assigned: true,
        grantedIds: ["cases.reply"],
      }),
    );
    expect([...s.permissions].sort()).toEqual(["cases.reply", "cases.view"]);
    expect(s.assigned).toBe(true);
  });
});
