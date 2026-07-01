import { useEffect, type ReactNode } from "react";
import type { RbacPermissionId } from "@support-agent/dashboard-contracts";

import { useSession } from "./session-context";
import { useAppNavigate } from "./navigation";

// Client-side front-door RBAC gate — the SPA port of the Next
// `requirePermission` redirect. The api enforces the real boundary; this just
// keeps a direct-URL visit from firing a gated fetch that would 403 (which the
// api-client treats as "needs onboarding") and instead bounces the member back
// to the cases home. Session permissions fail-open to empty on a load blip, in
// which case the home page (no permission required) still renders.

/** Returns whether the member has `permission`; redirects to "/" if not. */
export const useRequirePermission = (
  permission: RbacPermissionId,
): boolean => {
  const { permissions } = useSession();
  const nav = useAppNavigate();
  const allowed = permissions.has(permission);
  useEffect(() => {
    if (!allowed) nav.replace("/");
  }, [allowed, nav]);
  return allowed;
};

/** Renders `children` only for a member holding `permission`, else redirects. */
export function RequirePermission({
  permission,
  children,
}: {
  readonly permission: RbacPermissionId;
  readonly children: ReactNode;
}) {
  const allowed = useRequirePermission(permission);
  if (!allowed) return null;
  return <>{children}</>;
}
