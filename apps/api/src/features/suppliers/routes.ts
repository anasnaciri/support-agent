import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../../platform/context.js";
import { makeSupplierRoutes } from "../../auth/supplier-routes.js";
import { makeDashboardRoutes } from "../../auth/dashboard-routes.js";
import {
  handleSupplierCase,
  handleSupplierCases,
  handleSupplierInvite,
  handleSupplierSession,
  handleSupplierUpdate,
  handleSupplierWorkspaces,
} from "./handlers.js";

export const registerSupplierRoutes = (
  app: FastifyInstance,
  ctx: RouteContext,
): void => {
  const { supplierGet, supplierPost } = makeSupplierRoutes(app, ctx);
  const { dashboardGet, dashboardPost } = makeDashboardRoutes(app, ctx);

  // Supplier bootstrap + switcher — identity-only / binding-anchored, so NOT
  // gated by supplierGet (which needs an x-workspace-id + supplier.cases.* the
  // caller doesn't have yet at bootstrap). Each handler self-authenticates.
  dashboardGet(
    "/dashboard/supplier/workspaces",
    "Every workspace the signed-in supplier is bound to (across orgs)",
    handleSupplierWorkspaces,
  );
  dashboardGet(
    "/dashboard/supplier/session",
    "Binding-anchored supplier permissions for the active workspace",
    handleSupplierSession,
  );

  // Supplier-facing surface — gated on the constrained supplier.cases.* and
  // walled off from merchant endpoints by decideSupplierAuthz.
  supplierGet(
    "/dashboard/supplier/cases",
    "Open escalations for the logged-in supplier",
    handleSupplierCases,
    "supplier.cases.view",
  );
  supplierGet(
    "/dashboard/supplier/cases/:id",
    "One escalated case (minimal privacy projection)",
    handleSupplierCase,
    "supplier.cases.view",
  );
  supplierPost(
    "/dashboard/supplier/cases/:id/update",
    "Post a supplier update + resolve the escalation",
    handleSupplierUpdate,
    "supplier.cases.respond",
  );

  // Merchant-facing — invite a supplier into the workspace (members.manage).
  dashboardPost(
    "/dashboard/supplier/invite",
    "Invite a supplier (create the supplier + a pending invitation)",
    handleSupplierInvite,
    "members.manage",
  );
};
