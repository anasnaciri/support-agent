import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../../platform/context.js";
import { makeSupplierRoutes } from "../../auth/supplier-routes.js";
import { makeDashboardRoutes } from "../../auth/dashboard-routes.js";
import {
  handleSupplierAttachmentUpload,
  handleSupplierTicket,
  handleSupplierTickets,
  handleSupplierInvite,
  handleSupplierSession,
  handleSupplierTracking,
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
  // gated by supplierGet (which needs an x-workspace-id + supplier.tickets.* the
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

  // Supplier-facing surface — gated on the constrained supplier.tickets.* and
  // walled off from merchant endpoints by decideSupplierAuthz.
  supplierGet(
    "/dashboard/supplier/tickets",
    "Open escalations for the logged-in supplier",
    handleSupplierTickets,
    "supplier.tickets.view",
  );
  supplierGet(
    "/dashboard/supplier/tickets/:id",
    "One escalated ticket (minimal privacy projection)",
    handleSupplierTicket,
    "supplier.tickets.view",
  );
  supplierPost(
    "/dashboard/supplier/tickets/:id/update",
    "Post a supplier update + resolve the escalation",
    handleSupplierUpdate,
    "supplier.tickets.respond",
  );
  supplierPost(
    "/dashboard/supplier/tickets/:id/attachments",
    "Upload a file (raw bytes) to send with a supplier update",
    handleSupplierAttachmentUpload,
    "supplier.tickets.respond",
    // Global cap is 1 MiB; attachments follow the ingestion cap (10 MiB)
    // plus headroom.
    { bodyLimit: 11 * 1024 * 1024 },
  );
  supplierPost(
    "/dashboard/supplier/tickets/:id/tracking",
    "Replace the order's fulfillment tracking number (Shopify store write)",
    handleSupplierTracking,
    "supplier.tickets.respond",
  );

  // Merchant-facing — invite a supplier into the workspace (members.manage).
  dashboardPost(
    "/dashboard/supplier/invite",
    "Invite a supplier (create the supplier + a pending invitation)",
    handleSupplierInvite,
    "members.manage",
  );
};
