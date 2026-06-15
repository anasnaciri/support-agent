import "server-only";
import { redirect } from "next/navigation";
import { getDashboardContext, type DashboardContext } from "./api-client";

/**
 * Page guard for the supplier portal. Loads the dashboard context (a supplier
 * is a constrained WorkOS member, so this resolves normally) and redirects
 * anyone without `supplier.cases.view` back to "/". An owner has all-access and
 * may preview; the api enforces the real boundary (decideSupplierAuthz) and the
 * supplier handlers return only this supplier's rows.
 */
export const requireSupplierPermission =
  async (): Promise<DashboardContext> => {
    const ctx = await getDashboardContext();
    if (!ctx.permissions.has("supplier.cases.view")) redirect("/");
    return ctx;
  };
