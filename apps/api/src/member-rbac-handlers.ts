import { type FastifyReply, type FastifyRequest } from "fastify";
import {
  assignMemberRole,
  createInvitation,
  createRole,
  deleteRole,
  ensureActingOwnerInOpenMode,
  getMemberAccess,
  listMembers,
  listPendingInvitations,
  listRoles,
  reconcileInvitation,
  removeMember,
  renameRole,
  revokeInvitation,
  setRolePermissions,
} from "@support-agent/db";
import {
  RBAC_PERMISSIONS,
  isRbacPermissionId,
} from "@support-agent/dashboard-contracts";
import { sessionPermissions } from "./auth/dashboard-authz.js";
import { type ApiConfig, type ApiLayer } from "./bootstrap.js";
import { bodyStr, parseJsonBody, sendJson } from "./platform/http.js";
import {
  authenticateDashboard,
  getWorkosDirectory,
  runWithDb,
} from "./auth/dashboard-context.js";

// POST /dashboard/me/session — reconcile any pending invite for this user,
// then return their effective access for the active workspace. The dashboard
// calls this on every context load.
export const handleDashboardMeSession = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  if (!auth.userId) return sendJson(res, 401, { error: "missing_user" });
  const userId = auth.userId;
  // Reconcile a pending invite to a VERIFIED email only. The x-user-email header
  // is untrusted (S14), so an authenticated member can't claim an invite
  // addressed to someone else by spoofing it. We resolve the email from WorkOS
  // (keyed on the verified `sub`) — and only when a pending invite actually
  // exists, so the common no-invite load makes no WorkOS call.
  const pending = await runWithDb(layer, (db) =>
    listPendingInvitations(db, auth.tenantId),
  );
  const directory = getWorkosDirectory(req);
  let verifiedEmail: string | null = null;
  if (pending.length > 0 && auth.workosUserId && directory) {
    verifiedEmail = await directory.getEmail(auth.workosUserId);
  }
  const access = await runWithDb(layer, async (db) => {
    if (verifiedEmail) {
      await reconcileInvitation(db, auth.tenantId, {
        email: verifiedEmail,
        userDecisionUuid: userId,
        ...(auth.workosUserId ? { workosUserId: auth.workosUserId } : {}),
      });
    }
    return getMemberAccess(db, auth.tenantId, userId);
  });
  return sendJson(res, 200, sessionPermissions(access));
};

// Auto-claim helper for member-write handlers — requires the acting email.
export const claimOwnerIfOpen = (
  layer: ApiLayer,
  tenantId: string,
  userId: string,
  email: string,
): Promise<void> =>
  runWithDb(layer, (db) =>
    ensureActingOwnerInOpenMode(db, tenantId, userId, email),
  );

// GET /dashboard/permission-catalog — the static permission registry.
export const handleDashboardPermissionCatalog = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  return sendJson(res, 200, { permissions: RBAC_PERMISSIONS });
};

// GET /dashboard/members — members + pending invitations.
export const handleDashboardMembers = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const result = await runWithDb(layer, async (db) => ({
    members: await listMembers(db, auth.tenantId),
    invitations: await listPendingInvitations(db, auth.tenantId),
  }));
  return sendJson(res, 200, result);
};

// GET /dashboard/roles — roles with their grants + assigned counts.
export const handleDashboardRoles = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const roleRows = await runWithDb(layer, (db) => listRoles(db, auth.tenantId));
  return sendJson(res, 200, { roles: roleRows });
};

// POST /dashboard/members/invite — persist a pending invitation. The WorkOS
// email send happens dashboard-side; the api owns the row.
export const handleDashboardMemberInvite = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  if (!auth.userId || !auth.userEmail) {
    return sendJson(res, 400, { error: "missing_user" });
  }
  const invitedByUuid = auth.userId;
  const email = bodyStr(req, "email");
  const roleId = bodyStr(req, "roleId");
  if (!email || !roleId) return sendJson(res, 400, { error: "invalid_request" });
  const workosInvitationId = bodyStr(req, "workosInvitationId");
  await claimOwnerIfOpen(layer, auth.tenantId, invitedByUuid, auth.userEmail);
  const result = await runWithDb(layer, (db) =>
    createInvitation(db, auth.tenantId, {
      email,
      roleId,
      invitedByUuid,
      ...(workosInvitationId ? { workosInvitationId } : {}),
    }),
  );
  if (!result.ok) {
    const status = result.reason === "role_not_found" ? 404 : 409;
    return sendJson(res, status, { error: result.reason });
  }
  return sendJson(res, 200, { invitationId: result.invitationId });
};

// POST /dashboard/members/:uuid/role — change a member's role.
export const handleDashboardMemberRole = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { uuid } = req.params as { uuid: string };
  const roleId = bodyStr(req, "roleId");
  if (!roleId) return sendJson(res, 400, { error: "invalid_request" });
  const result = await runWithDb(layer, (db) =>
    assignMemberRole(db, auth.tenantId, uuid, roleId),
  );
  if (!result.ok) {
    const status = result.reason === "role_not_found" ? 404 : 404;
    return sendJson(res, status, { error: result.reason });
  }
  return sendJson(res, 200, { ok: true });
};

// POST /dashboard/members/:uuid/remove — remove a member's assignment.
export const handleDashboardMemberRemove = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { uuid } = req.params as { uuid: string };
  const result = await runWithDb(layer, (db) =>
    removeMember(db, auth.tenantId, uuid),
  );
  if (!result.ok) return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, 200, { ok: true });
};

// POST /dashboard/invitations/:id/revoke — revoke a pending invitation.
export const handleDashboardInvitationRevoke = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  const result = await runWithDb(layer, (db) =>
    revokeInvitation(db, auth.tenantId, id),
  );
  if (!result.ok) return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, 200, { ok: true });
};

// POST /dashboard/roles — create a new (empty) role.
export const handleDashboardRoleCreate = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  if (!auth.userId || !auth.userEmail) {
    return sendJson(res, 400, { error: "missing_user" });
  }
  const name = bodyStr(req, "name");
  if (!name) return sendJson(res, 400, { error: "invalid_request" });
  await claimOwnerIfOpen(layer, auth.tenantId, auth.userId, auth.userEmail);
  const result = await runWithDb(layer, (db) =>
    createRole(db, auth.tenantId, name),
  );
  if (!result.ok) return sendJson(res, 409, { error: result.reason });
  return sendJson(res, 200, { roleId: result.roleId });
};

// POST /dashboard/roles/:id/rename
export const handleDashboardRoleRename = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  const name = bodyStr(req, "name");
  if (!name) return sendJson(res, 400, { error: "invalid_request" });
  const result = await runWithDb(layer, (db) =>
    renameRole(db, auth.tenantId, id, name),
  );
  if (!result.ok) {
    const status = result.reason === "not_found" ? 404 : 409;
    return sendJson(res, status, { error: result.reason });
  }
  return sendJson(res, 200, { ok: true });
};

// POST /dashboard/roles/:id/permissions — replace a role's permission grants.
export const handleDashboardRolePermissions = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  const raw = parseJsonBody(req)["permissionIds"];
  const ids = Array.isArray(raw)
    ? raw.filter((x): x is string => typeof x === "string")
    : [];
  if (ids.some((pid) => !isRbacPermissionId(pid))) {
    return sendJson(res, 400, { error: "invalid_permission" });
  }
  const result = await runWithDb(layer, (db) =>
    setRolePermissions(db, auth.tenantId, id, ids),
  );
  if (!result.ok) {
    const status = result.reason === "not_found" ? 404 : 409;
    return sendJson(res, status, { error: result.reason });
  }
  return sendJson(res, 200, { ok: true });
};

// POST /dashboard/roles/:id/delete
export const handleDashboardRoleDelete = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  const result = await runWithDb(layer, (db) =>
    deleteRole(db, auth.tenantId, id),
  );
  if (!result.ok) {
    const status = result.reason === "not_found" ? 404 : 409;
    return sendJson(res, status, { error: result.reason });
  }
  return sendJson(res, 200, { ok: true });
};
