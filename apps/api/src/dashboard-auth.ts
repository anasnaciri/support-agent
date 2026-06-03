import { timingSafeEqual } from "node:crypto";

// Auth for the dashboard's HTTP API (Path B). The dashboard (a Cloudflare
// Worker) authenticates the merchant via WorkOS, then calls apps/api with a
// shared service token plus the asserted WorkOS organization id. The api
// trusts the token (only the dashboard holds it) and maps org -> tenant to
// scope the read. This is the pilot model; a stricter variant that verifies
// a forwarded WorkOS access-token JWT can replace this parser without
// touching the endpoints.

export type DashboardAuthParse =
  | { readonly ok: true; readonly organizationId: string }
  | { readonly ok: false; readonly status: 401 | 400; readonly message: string };

const BEARER = "Bearer ";

const constantTimeEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // timingSafeEqual throws on length mismatch; guard so a wrong-length token
  // is a clean false, not an exception.
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
};

/**
 * Validate the dashboard's `Authorization: Bearer <service-token>` and read
 * the asserted `x-org-id`. Pure — tenant resolution happens after, against
 * the DB. Header keys are expected lowercased (as Fastify delivers them).
 */
export const parseDashboardAuth = (
  headers: Record<string, string | undefined>,
  expectedToken: string,
): DashboardAuthParse => {
  const auth = headers["authorization"];
  if (!auth || !auth.startsWith(BEARER)) {
    return { ok: false, status: 401, message: "missing bearer token" };
  }
  const token = auth.slice(BEARER.length);
  if (!constantTimeEqual(token, expectedToken)) {
    return { ok: false, status: 401, message: "invalid token" };
  }
  const org = headers["x-org-id"];
  if (!org) {
    return { ok: false, status: 400, message: "missing x-org-id" };
  }
  return { ok: true, organizationId: org };
};
