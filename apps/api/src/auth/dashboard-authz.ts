// Human-member authorization for the `/dashboard/*` API. Pure decision logic
// over the member's access facts (loaded by the db's getMemberAccess); kept
// separate from server.ts so it's unit-testable without a Fastify request.
//
// This gates HUMAN members. It is unrelated to the agent's tool-call
// PermissionService (which gates the AI). Do not conflate them.

import {
  effectivePermissions,
  type RbacPermissionId,
} from "@support-agent/dashboard-contracts";
import type { MemberAccess } from "@support-agent/db";

export type AuthzDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 401 | 403; readonly error: string };

/**
 * Decide whether the acting member may perform an action requiring `required`.
 *
 * - No user id on the request → 401 (a write/guarded read must identify the
 *   actor; the dashboard now sends `x-user-id` on reads too).
 * - Workspace in OPEN mode (no member assignments yet) → allow, so the
 *   incumbent operator is never locked out before roles are configured.
 * - Owner → allow everything.
 * - Otherwise the member's effective (implication-expanded) permissions must
 *   include `required`.
 */
export const decideAuthz = (
  access: MemberAccess,
  userDecisionUuid: string | undefined,
  required: RbacPermissionId,
): AuthzDecision => {
  // Open mode FIRST — a workspace with no assignments behaves like the
  // pre-RBAC system (any org member, no actor id needed). This also keeps
  // existing read flows working before the workspace adopts roles.
  if (!access.anyAssignmentsInWorkspace) return { ok: true };
  // Enforced mode needs to know WHO is acting.
  if (!userDecisionUuid) {
    return { ok: false, status: 401, error: "missing_user" };
  }
  if (access.isOwner) return { ok: true };
  const perms = effectivePermissions({
    isOwner: false,
    grantedIds: access.grantedIds,
  });
  return perms.has(required)
    ? { ok: true }
    : { ok: false, status: 403, error: "forbidden" };
};

/**
 * FulfillmentOperator-endpoint authorization — deliberately STRICTER than decideAuthz. A
 * fulfillmentOperator is an external party with a heavily-constrained FulfillmentOperator role, so
 * fulfillmentOperator endpoints must NOT honor open mode (a real fulfillmentOperator always has an
 * explicit assignment row) and must require a `fulfillment_operator.tickets.*` permission. A
 * merchant member who lacks those is denied; an owner may preview.
 *
 * - No acting user id → 401.
 * - Not assigned in this workspace → 403 (the open-mode bypass that decideAuthz
 *   grants must never reach a fulfillment partner endpoint).
 * - Owner → allow.
 * - Otherwise the member's effective (implication-expanded) permissions must
 *   include `required`.
 */
export const decideFulfillmentOperatorAuthz = (
  access: MemberAccess,
  userDecisionUuid: string | undefined,
  required: RbacPermissionId,
): AuthzDecision => {
  if (!userDecisionUuid) {
    return { ok: false, status: 401, error: "missing_user" };
  }
  if (!access.assigned) {
    return { ok: false, status: 403, error: "forbidden" };
  }
  if (access.isOwner) return { ok: true };
  const perms = effectivePermissions({
    isOwner: false,
    grantedIds: access.grantedIds,
  });
  return perms.has(required)
    ? { ok: true }
    : { ok: false, status: 403, error: "forbidden" };
};

export interface SessionPermissions {
  readonly isOwner: boolean;
  readonly permissions: ReadonlyArray<RbacPermissionId>;
  readonly assigned: boolean;
}

/**
 * The acting member's own access, for `GET /dashboard/me/session` and the
 * dashboard nav gating. Owner OR open-mode ⇒ every permission (so the nav shows
 * everything the api would actually allow).
 */
export const sessionPermissions = (access: MemberAccess): SessionPermissions => {
  const openOrOwner = access.isOwner || !access.anyAssignmentsInWorkspace;
  const perms = effectivePermissions({
    isOwner: openOrOwner,
    grantedIds: access.grantedIds,
  });
  return {
    isOwner: access.isOwner,
    permissions: [...perms],
    assigned: access.assigned,
  };
};
