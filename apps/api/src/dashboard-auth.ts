import { timingSafeEqual } from "node:crypto";

// Auth for the dashboard's HTTP API (Path B). The dashboard (a Cloudflare
// Worker) authenticates the merchant via WorkOS, then calls apps/api with a
// shared service token plus the asserted WorkOS organization id. The api
// trusts the token (only the dashboard holds it) and maps org -> tenant to
// scope the read. This is the pilot model; a stricter variant that verifies
// a forwarded WorkOS access-token JWT can replace this parser without
// touching the endpoints.

export type DashboardAuthParse =
  | {
      readonly ok: true;
      readonly organizationId: string;
      /**
       * Manager id for write actions (from `x-user-id`). The dashboard sends
       * the WorkOS-user → decision UUID it already derives; undefined on read
       * requests, which don't need it.
       */
      readonly userId: string | undefined;
      /**
       * Workspace (tenant row) the request is pinned to, from
       * `x-workspace-id`. Undefined → the org's default workspace. Shape and
       * ownership are checked after parsing, against the DB.
       */
      readonly workspaceId: string | undefined;
    }
  | { readonly ok: false; readonly status: 401 | 400; readonly message: string };

/**
 * `tenants.id` is a Postgres `uuid` — comparing it against a non-UUID string
 * throws a cast error (a 500). Gate the self-asserted `x-workspace-id` on
 * shape so garbage becomes a clean 400 before any query runs.
 */
const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isWorkspaceIdShape = (value: string): boolean =>
  UUID_SHAPE.test(value);

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
  const userId = headers["x-user-id"];
  const workspaceId = headers["x-workspace-id"];
  return {
    ok: true,
    organizationId: org,
    userId: userId && userId.length > 0 ? userId : undefined,
    workspaceId:
      workspaceId && workspaceId.length > 0 ? workspaceId : undefined,
  };
};

export type AdminAuthParse =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 401; readonly message: string };

/**
 * Validate the platform-operator `Authorization: Bearer <admin-token>` for
 * the `/admin/*` routes. No org/tenant scoping — admin acts across tenants.
 */
export const parseAdminAuth = (
  headers: Record<string, string | undefined>,
  expectedToken: string,
): AdminAuthParse => {
  const auth = headers["authorization"];
  if (!auth || !auth.startsWith(BEARER)) {
    return { ok: false, status: 401, message: "missing bearer token" };
  }
  const token = auth.slice(BEARER.length);
  if (!constantTimeEqual(token, expectedToken)) {
    return { ok: false, status: 401, message: "invalid token" };
  }
  return { ok: true };
};
