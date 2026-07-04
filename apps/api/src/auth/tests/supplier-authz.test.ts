import { describe, expect, it } from "vitest";
import type { MemberAccess } from "@support-agent/db";
import { decideSupplierAuthz } from "../dashboard-authz.js";

const access = (over: Partial<MemberAccess>): MemberAccess => ({
  assigned: false,
  isOwner: false,
  grantedIds: [],
  anyAssignmentsInWorkspace: false,
  ...over,
});

// The supplier-endpoint guard is deliberately STRICTER than decideAuthz: it must
// never honor open mode (a supplier always has an explicit assignment) and it
// requires the supplier.tickets.* permission — so a merchant member can't reach
// supplier endpoints and an unassigned/open-mode user can't either.
describe("decideSupplierAuthz", () => {
  it("401s when there's no acting user id", () => {
    expect(
      decideSupplierAuthz(
        access({ anyAssignmentsInWorkspace: true, assigned: true }),
        undefined,
        "supplier.tickets.view",
      ),
    ).toEqual({ ok: false, status: 401, error: "missing_user" });
  });

  it("does NOT honor open mode — an unassigned user is denied (the isolation ticket)", () => {
    expect(
      decideSupplierAuthz(
        access({ anyAssignmentsInWorkspace: false }),
        "u",
        "supplier.tickets.view",
      ),
    ).toEqual({ ok: false, status: 403, error: "forbidden" });
  });

  it("denies an assigned user with no supplier assignment row", () => {
    expect(
      decideSupplierAuthz(
        access({ anyAssignmentsInWorkspace: true, assigned: false }),
        "u",
        "supplier.tickets.view",
      ),
    ).toEqual({ ok: false, status: 403, error: "forbidden" });
  });

  it("denies an assigned merchant member who lacks the supplier permission", () => {
    expect(
      decideSupplierAuthz(
        access({
          anyAssignmentsInWorkspace: true,
          assigned: true,
          grantedIds: ["tickets.reply"],
        }),
        "u",
        "supplier.tickets.view",
      ),
    ).toEqual({ ok: false, status: 403, error: "forbidden" });
  });

  it("allows a supplier with the grant (respond implies view)", () => {
    const supplier = access({
      anyAssignmentsInWorkspace: true,
      assigned: true,
      grantedIds: ["supplier.tickets.respond"],
    });
    expect(decideSupplierAuthz(supplier, "u", "supplier.tickets.respond")).toEqual(
      { ok: true },
    );
    expect(decideSupplierAuthz(supplier, "u", "supplier.tickets.view")).toEqual({
      ok: true,
    });
  });

  it("allows an owner (preview)", () => {
    expect(
      decideSupplierAuthz(
        access({
          anyAssignmentsInWorkspace: true,
          assigned: true,
          isOwner: true,
        }),
        "u",
        "supplier.tickets.respond",
      ),
    ).toEqual({ ok: true });
  });
});
