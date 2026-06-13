import { describe, expect, it } from "vitest";

import { dashboardUserDecisionUuid } from "../src/dashboard-user-id.js";

// The decision UUID is the stable one-way mapping from a WorkOS user id to the
// `uuid` PK used by approvals.decided_by and member_role_assignments.member_id.
// Before S14 the dashboard COMPUTED this and sent it as the (untrusted)
// `x-user-id` header; the api now derives it server-side from the verified
// `sub` claim of the forwarded WorkOS access token. For existing role
// assignments / approval decisions to keep matching the same person, the api's
// derivation MUST be byte-for-byte identical to what the dashboard used to send.
// These golden values pin that contract (they mirror the dashboard's
// lib/user-id.ts golden values).
describe("dashboardUserDecisionUuid", () => {
  it("maps a WorkOS user id to the pinned decision UUID", () => {
    expect(dashboardUserDecisionUuid("user_01ABC")).toBe(
      "f84538f1-c386-5155-8cbd-a86ec1347321",
    );
    expect(dashboardUserDecisionUuid("user_01HXYZ7QK9")).toBe(
      "69ed40a0-653e-5d25-9aa2-fe237885062b",
    );
  });

  it("is deterministic and RFC-4122 v5-shaped", () => {
    const a = dashboardUserDecisionUuid("user_repeat");
    expect(dashboardUserDecisionUuid("user_repeat")).toBe(a);
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("gives distinct ids for distinct users", () => {
    expect(dashboardUserDecisionUuid("user_a")).not.toBe(
      dashboardUserDecisionUuid("user_b"),
    );
  });
});
