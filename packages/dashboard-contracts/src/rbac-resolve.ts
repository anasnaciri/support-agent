// Pure RBAC resolution — shared by the api guard and the dashboard nav gating.
// No IO, no node built-ins; safe in the Worker bundle and trivially unit-tested.

import {
  RBAC_PERMISSIONS,
  RBAC_PERMISSION_IDS,
  type RbacPermissionId,
} from "./rbac-permissions.js";

// id -> the ids it directly grants (the `implies` edges), precomputed once.
const IMPLIES: ReadonlyMap<RbacPermissionId, ReadonlyArray<RbacPermissionId>> =
  new Map(RBAC_PERMISSIONS.map((p) => [p.id, p.implies ?? []]));

const ALL_IDS: ReadonlyArray<RbacPermissionId> = RBAC_PERMISSIONS.map(
  (p) => p.id,
);

/**
 * The member's effective permission set for one workspace.
 *
 * - An owner gets EVERY permission (the all-access short-circuit), independent
 *   of any granted ids.
 * - Otherwise the granted ids are validated against the catalog (unknown ids
 *   are dropped) and expanded through the `implies` closure, so granting
 *   `tickets.reply` also yields `tickets.view`.
 */
export const effectivePermissions = (input: {
  readonly isOwner: boolean;
  readonly grantedIds: ReadonlyArray<string>;
}): ReadonlySet<RbacPermissionId> => {
  if (input.isOwner) return new Set(ALL_IDS);

  const out = new Set<RbacPermissionId>();
  const add = (id: RbacPermissionId): void => {
    if (out.has(id)) return;
    out.add(id);
    for (const implied of IMPLIES.get(id) ?? []) add(implied);
  };

  for (const raw of input.grantedIds) {
    if ((RBAC_PERMISSION_IDS as ReadonlySet<string>).has(raw)) {
      add(raw as RbacPermissionId);
    }
  }
  return out;
};

export const hasPermission = (
  perms: ReadonlySet<RbacPermissionId>,
  required: RbacPermissionId,
): boolean => perms.has(required);
