import { describe, expect, it } from "vitest";
import type { MemberAccess } from "@support-agent/db";
import { decideFulfillmentOperatorAuthz } from "../dashboard-authz.js";

const access = (over: Partial<MemberAccess>): MemberAccess => ({
  assigned: false,
  isOwner: false,
  grantedIds: [],
  anyAssignmentsInWorkspace: false,
  ...over,
});

// The fulfillment-operator-endpoint guard is deliberately STRICTER than decideAuthz: it must
// never honor open mode (a fulfillment partner always has an explicit assignment) and it
// requires the constrained `fulfillment_operator.tickets.*` permission — so a merchant member can't reach
// fulfillmentOperator endpoints and an unassigned/open-mode user can't either.
describe("decideFulfillmentOperatorAuthz", () => {
  it("401s when there's no acting user id", () => {
    expect(
      decideFulfillmentOperatorAuthz(
        access({ anyAssignmentsInWorkspace: true, assigned: true }),
        undefined,
        "fulfillment_operator.tickets.view",
      ),
    ).toEqual({ ok: false, status: 401, error: "missing_user" });
  });

  it("does NOT honor open mode — an unassigned user is denied (the isolation ticket)", () => {
    expect(
      decideFulfillmentOperatorAuthz(
        access({ anyAssignmentsInWorkspace: false }),
        "u",
        "fulfillment_operator.tickets.view",
      ),
    ).toEqual({ ok: false, status: 403, error: "forbidden" });
  });

  it("denies an assigned user with no fulfillment partner assignment row", () => {
    expect(
      decideFulfillmentOperatorAuthz(
        access({ anyAssignmentsInWorkspace: true, assigned: false }),
        "u",
        "fulfillment_operator.tickets.view",
      ),
    ).toEqual({ ok: false, status: 403, error: "forbidden" });
  });

  it("denies an assigned merchant member who lacks the fulfillment partner permission", () => {
    expect(
      decideFulfillmentOperatorAuthz(
        access({
          anyAssignmentsInWorkspace: true,
          assigned: true,
          grantedIds: ["tickets.reply"],
        }),
        "u",
        "fulfillment_operator.tickets.view",
      ),
    ).toEqual({ ok: false, status: 403, error: "forbidden" });
  });

  it("allows a fulfillment partner with the grant (respond implies view)", () => {
    const fulfillmentOperator = access({
      anyAssignmentsInWorkspace: true,
      assigned: true,
      grantedIds: ["fulfillment_operator.tickets.respond"],
    });
    expect(decideFulfillmentOperatorAuthz(fulfillmentOperator, "u", "fulfillment_operator.tickets.respond")).toEqual(
      { ok: true },
    );
    expect(decideFulfillmentOperatorAuthz(fulfillmentOperator, "u", "fulfillment_operator.tickets.view")).toEqual({
      ok: true,
    });
  });

  it("allows an owner (preview)", () => {
    expect(
      decideFulfillmentOperatorAuthz(
        access({
          anyAssignmentsInWorkspace: true,
          assigned: true,
          isOwner: true,
        }),
        "u",
        "fulfillment_operator.tickets.respond",
      ),
    ).toEqual({ ok: true });
  });
});
