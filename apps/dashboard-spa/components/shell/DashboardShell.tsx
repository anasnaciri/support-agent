import type { ReactNode } from "react";
import { Outlet } from "@tanstack/react-router";

import { SessionProvider, useSession } from "@/lib/session-context";
import { AppShell } from "./AppShell";

// Feeds the presentational AppShell from the session context (the Next app fed
// it from RSC props). Wrapped in SessionProvider so the whole authed area is
// gated behind a resolved WorkOS session + workspace.
function ShellFromSession({ children }: { children: ReactNode }) {
  const s = useSession();
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
