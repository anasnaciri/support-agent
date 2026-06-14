import { createHash } from "node:crypto";

// approvals.decided_by and member_role_assignments.member_id are `uuid` columns,
// while WorkOS user ids are provider strings (`user_…`). This is the stable
// one-way mapping between them.
//
// S14: the api derives this from the VERIFIED `sub` claim of the forwarded
// WorkOS access token — it no longer trusts a caller-asserted `x-user-id`. The
// value must stay byte-for-byte identical to what the dashboard's lib/user-id.ts
// historically computed, or existing role assignments / approval decisions stop
// matching the same person. Both copies are pinned by golden tests; the small
// duplication is deliberate (dashboard-contracts is Worker-safe and forbids
// `node:` built-ins, so the shared hash can't live there).
export const dashboardUserDecisionUuid = (workosUserId: string): string => {
  const bytes = createHash("sha256")
    .update(`workos:${workosUserId}`)
    .digest()
    .subarray(0, 16);

  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
};
