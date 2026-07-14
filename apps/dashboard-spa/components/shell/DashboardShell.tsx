import { useEffect, type ReactNode } from "react";
import { Outlet } from "@tanstack/react-router";

import { SessionProvider, useSession } from "@/lib/session-context";
import { useAppNavigate, usePathname } from "@/lib/navigation";
import { setupWizardRedirect } from "@/lib/setup-wizard-gate";
import { AppShell } from "./AppShell";

// Feeds the presentational AppShell from the session context (the Next app fed
// it from RSC props). Wrapped in SessionProvider so the whole authed area is
// gated behind a resolved WorkOS session + workspace.
function ShellFromSession({ children }: { children: ReactNode }) {
  const s = useSession();
  const nav = useAppNavigate();
  const pathname = usePathname() ?? "/";

  // A workspace created since the setup wizard shipped, and not yet finished or
  // dismissed, belongs in the wizard rather than in an empty dashboard. This is
  // also what catches a connector OAuth round-trip: Shopify and Google redirect
  // to /settings/integrations, and mid-onboarding that lands here first — the
  // redirect carries the callback's params along so the wizard can report the
  // outcome. Pre-wizard workspaces are never pending, so they never see this.
  const redirect = setupWizardRedirect({
    activeWorkspace: s.activeWorkspace,
    pathname,
    search: window.location.search,
  });
  useEffect(() => {
    if (redirect) nav.replace(redirect);
  }, [nav, redirect]);

  return (
    <AppShell
      email={s.user.email}
      workspaces={s.workspaces}
      activeWorkspaceId={s.activeWorkspaceId}
      permissions={[...s.permissions]}
    >
      {children}
    </AppShell>
  );
}

/** The `_authed` route layout: gate → shell → nested route outlet. */
export function AuthedLayout() {
  return (
    <SessionProvider>
      <ShellFromSession>
        <Outlet />
      </ShellFromSession>
    </SessionProvider>
  );
}

/**
 * Authed, but WITHOUT the dashboard shell — the setup wizard's layout.
 *
 * The wizard needs the session (it configures the active workspace), but not the
 * nav rail: it is a single ordered task, and a sidebar full of half-configured
 * settings pages beside it is just a set of ways to lose the thread.
 */
export function AuthedBareLayout() {
  return (
    <SessionProvider>
      <Outlet />
    </SessionProvider>
  );
}
