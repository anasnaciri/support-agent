import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../../platform/context.js";
import { makeFulfillmentOperatorRoutes } from "../../auth/fulfillment-operator-routes.js";
import { makeDashboardRoutes } from "../../auth/dashboard-routes.js";
import {
  handleFulfillmentOperatorAttachmentUpload,
  handleFulfillmentOperatorAttachmentUrl,
  handleFulfillmentOperatorTicket,
  handleFulfillmentOperatorTickets,
  handleFulfillmentOperatorInvite,
  handleFulfillmentOperatorSession,
  handleFulfillmentOperatorTracking,
  handleFulfillmentOperatorUpdate,
  handleFulfillmentOperatorWorkspaces,
} from "./handlers.js";

export const registerFulfillmentOperatorRoutes = (
  app: FastifyInstance,
  ctx: RouteContext,
): void => {
  const { fulfillmentOperatorGet, fulfillmentOperatorPost } = makeFulfillmentOperatorRoutes(app, ctx);
  const { dashboardGet, dashboardPost } = makeDashboardRoutes(app, ctx);

  // FulfillmentOperator bootstrap + switcher — identity-only / binding-anchored, so NOT
  // gated by fulfillmentOperatorGet (which needs an x-workspace-id + fulfillment_operator.tickets.* the
  // caller doesn't have yet at bootstrap). Each handler self-authenticates.
  dashboardGet(
    "/dashboard/fulfillment-operator/workspaces",
    "Every workspace the signed-in fulfillment partner is bound to (across orgs)",
    handleFulfillmentOperatorWorkspaces,
  );
  dashboardGet(
    "/dashboard/fulfillment-operator/session",
    "Binding-anchored fulfillment partner permissions for the active workspace",
    handleFulfillmentOperatorSession,
  );

  // FulfillmentOperator-facing surface — gated on the constrained fulfillment_operator.tickets.* and
  // walled off from merchant endpoints by decideFulfillmentOperatorAuthz.
  fulfillmentOperatorGet(
    "/dashboard/fulfillment-operator/tickets",
    "Open escalations for the logged-in fulfillment partner",
    handleFulfillmentOperatorTickets,
    "fulfillment_operator.tickets.view",
  );
  fulfillmentOperatorGet(
    "/dashboard/fulfillment-operator/tickets/:id/attachments/:attachmentId/url",
    "A short-lived preview URL for an escalation attachment",
    handleFulfillmentOperatorAttachmentUrl,
    "fulfillment_operator.tickets.view",
  );
  fulfillmentOperatorGet(
    "/dashboard/fulfillment-operator/tickets/:id",
    "One escalated ticket (minimal privacy projection)",
    handleFulfillmentOperatorTicket,
    "fulfillment_operator.tickets.view",
  );
  fulfillmentOperatorPost(
    "/dashboard/fulfillment-operator/tickets/:id/update",
    "Post a fulfillment partner update + resolve the escalation",
    handleFulfillmentOperatorUpdate,
    "fulfillment_operator.tickets.respond",
  );
  fulfillmentOperatorPost(
    "/dashboard/fulfillment-operator/tickets/:id/attachments",
    "Upload a file (raw bytes) to send with a fulfillment partner update",
    handleFulfillmentOperatorAttachmentUpload,
    "fulfillment_operator.tickets.respond",
    // Global cap is 1 MiB; attachments follow the ingestion cap (10 MiB)
    // plus headroom.
    { bodyLimit: 11 * 1024 * 1024 },
  );
  fulfillmentOperatorPost(
    "/dashboard/fulfillment-operator/tickets/:id/tracking",
    "Replace the order's fulfillment tracking number (Shopify store write)",
    handleFulfillmentOperatorTracking,
    "fulfillment_operator.tickets.respond",
  );

  // Merchant-facing — invite a fulfillment partner into the workspace (members.manage).
  dashboardPost(
    "/dashboard/fulfillment-operator/invite",
    "Invite a fulfillment partner (create the fulfillment partner + a pending invitation)",
    handleFulfillmentOperatorInvite,
    "members.manage",
  );
};
