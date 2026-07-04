import "server-only";
import { redirect } from "next/navigation";
import type { RbacPermissionId } from "@support-agent/dashboard-contracts";
import { getDashboardContext, type DashboardContext } from "./api-client";

/**
 * Page-level RBAC guard for admin pages. Loads the dashboard context and
 * redirects a member who lacks `permission` back to the tickets home ("/")
 * instead of letting the page's gated data fetch 403 (which the api-client
 * would otherwise treat as "needs onboarding"). Returns the context so the
 * page can reuse it without a second round-trip.
 *
 * The api enforces the real boundary; this is the front-door redirect for a
 * direct-URL visit and keeps the UX clean.
 */
export const requirePermission = async (
  permission: RbacPermissionId,
): Promise<DashboardContext> => {
  const ctx = await getDashboardContext();
  if (!ctx.permissions.has(permission)) redirect("/");
  return ctx;
};
