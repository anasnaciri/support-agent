import "server-only";
import { createHash } from "node:crypto";

// Approval.decided_by is a uuid column, while WorkOS user ids are provider
// strings. Keep a stable one-way mapping so dashboard actions can write the
// existing schema and still identify the same manager across requests.
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
