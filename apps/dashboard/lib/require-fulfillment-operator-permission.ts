import "server-only";
import { redirect } from "next/navigation";
import { getDashboardContext, type DashboardContext } from "./api-client";

/**
 * Page guard for the fulfillment partner portal. Loads the dashboard context (a fulfillment partner
 * is a constrained WorkOS member, so this resolves normally) and redirects
 * anyone without `fulfillment_operator.tickets.view` back to "/". An owner has all-access and
 * may preview; the api enforces the real boundary (decideFulfillmentOperatorAuthz) and the
 * fulfillmentOperator handlers return only this fulfillment partner's rows.
 */
export const requireFulfillmentOperatorPermission =
  async (): Promise<DashboardContext> => {
    const ctx = await getDashboardContext();
    if (!ctx.permissions.has("fulfillment_operator.tickets.view")) redirect("/");
    return ctx;
  };
