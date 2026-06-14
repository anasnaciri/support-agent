import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../../platform/context.js";
import { makeDashboardRoutes } from "../../auth/dashboard-routes.js";
import {
  handleDashboardInvitationRevoke,
  handleDashboardMemberInvite,
  handleDashboardMemberRemove,
  handleDashboardMemberRole,
  handleDashboardMembers,
  handleDashboardMeSession,
  handleDashboardPermissionCatalog,
  handleDashboardRoleCreate,
  handleDashboardRoleDelete,
  handleDashboardRolePermissions,
  handleDashboardRoleRename,
  handleDashboardRoles,
} from "./rbac-handlers.js";

export const registerMemberRoutes = (
  app: FastifyInstance,
  ctx: RouteContext,
): void => {
  const { dashboardGet, dashboardPost } = makeDashboardRoutes(app, ctx);

  // ---- Member RBAC ----
  // /me/session is reachable by any member (it's how the dashboard loads its
  // own access); everything else requires members.manage.
  dashboardPost(
    "/dashboard/me/session",
    "Reconcile invites + return the acting member's access",
    handleDashboardMeSession,
  );
  dashboardGet(
    "/dashboard/permission-catalog",
    "Static RBAC permission catalog",
    handleDashboardPermissionCatalog,
    "members.manage",
  );
  dashboardGet(
    "/dashboard/members",
    "Workspace members + pending invitations",
    handleDashboardMembers,
    "members.manage",
  );
  dashboardGet(
    "/dashboard/roles",
    "Workspace roles + grants",
    handleDashboardRoles,
    "members.manage",
  );
  dashboardPost(
    "/dashboard/members/invite",
    "Invite a member (persist a pending invitation)",
    handleDashboardMemberInvite,
    "members.manage",
  );
  dashboardPost(
    "/dashboard/members/:uuid/role",
    "Change a member's role",
    handleDashboardMemberRole,
    "members.manage",
  );
  dashboardPost(
    "/dashboard/members/:uuid/remove",
    "Remove a member",
    handleDashboardMemberRemove,
    "members.manage",
  );
  dashboardPost(
    "/dashboard/invitations/:id/revoke",
    "Revoke a pending invitation",
    handleDashboardInvitationRevoke,
    "members.manage",
  );
  dashboardPost(
    "/dashboard/roles",
    "Create a role",
    handleDashboardRoleCreate,
    "members.manage",
  );
  dashboardPost(
    "/dashboard/roles/:id/rename",
    "Rename a role",
    handleDashboardRoleRename,
    "members.manage",
  );
  dashboardPost(
    "/dashboard/roles/:id/permissions",
    "Replace a role's permission grants",
    handleDashboardRolePermissions,
    "members.manage",
  );
  dashboardPost(
    "/dashboard/roles/:id/delete",
    "Delete a role",
    handleDashboardRoleDelete,
    "members.manage",
  );
};
