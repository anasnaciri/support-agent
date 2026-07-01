import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  RbacPermissionId,
  WorkspaceSummary,
} from "@support-agent/dashboard-contracts";

import { getMeSession, getWorkspaces } from "./api-client";
import { getAuthSession, login, type AuthSession } from "./auth/session-api";
import type { SessionUser } from "./auth/types";
import { qk, workspaceScopedKeyPrefixes } from "./query-keys";
import { WORKSPACE_COOKIE, pickActiveWorkspace } from "./workspace";
import { useAppNavigate } from "./navigation";

// The client-side replacement for the RSC `getDashboardContext` gate: bootstrap
// the WorkOS session (BFF whoami), the org's workspaces, the active workspace
// (localStorage, default-tolerant), and the member's effective permissions for
// nav gating. Gates the whole authed area — children only render once resolved.

const readStoredWorkspace = (): string | undefined => {
  try {
    return localStorage.getItem(WORKSPACE_COOKIE) ?? undefined;
  } catch {
    return undefined;
  }
};

export interface SessionValue {
  readonly organizationId: string;
  readonly userId: string;
  readonly user: SessionUser;
  readonly workspaces: ReadonlyArray<WorkspaceSummary>;
  readonly activeWorkspace: WorkspaceSummary;
  readonly activeWorkspaceId: string;
  readonly permissions: ReadonlySet<RbacPermissionId>;
  readonly isOwner: boolean;
  readonly setActiveWorkspace: (id: string) => void;
}

const SessionContext = createContext<SessionValue | null>(null);

export const useSession = (): SessionValue => {
  const v = useContext(SessionContext);
  if (!v) throw new Error("useSession must be used within <SessionProvider>");
  return v;
};

/** The active workspace ctx for api-client calls: `api.today(useWorkspaceCtx())`. */
export const useWorkspaceCtx = (): { readonly workspaceId: string } => ({
  workspaceId: useSession().activeWorkspaceId,
});

const Splash = ({ label }: { label: string }) => (
  <div className="flex min-h-screen items-center justify-center bg-background">
    <p className="text-sm text-muted-foreground">{label}</p>
  </div>
);

export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const nav = useAppNavigate();
  const [storedId, setStoredId] = useState<string | undefined>(
    readStoredWorkspace,
  );

  const authQuery = useQuery<AuthSession>({
    queryKey: qk.authSession,
    queryFn: getAuthSession,
    retry: false,
    staleTime: 60_000,
  });

  const workspacesQuery = useQuery({
    queryKey: qk.workspaces,
    queryFn: () => getWorkspaces(),
    enabled: authQuery.isSuccess,
  });

  const workspaces = workspacesQuery.data?.workspaces ?? [];
  const active = useMemo(
    () => pickActiveWorkspace(workspaces, storedId),
    [workspaces, storedId],
  );

  const meQuery = useQuery({
    queryKey: active ? qk.me(active.id) : ["me", "none"],
    queryFn: () => getMeSession({ workspaceId: active!.id }),
    enabled: Boolean(active),
  });

  const setActiveWorkspace = useCallback(
    (id: string) => {
      try {
        localStorage.setItem(WORKSPACE_COOKIE, id);
      } catch {
        /* private mode — the pick falls back to default next load */
      }
      setStoredId(id);
      // Belt-and-suspenders: keys already include workspaceId, but drop the
      // scoped caches so nothing stale flashes before refetch.
      for (const prefix of workspaceScopedKeyPrefixes) {
        void queryClient.invalidateQueries({ queryKey: [prefix] });
      }
    },
    [queryClient],
  );

  // No session → into the WorkOS handshake (full-page). The global query
  // error handler also does this; here we cover the initial-load 401.
  useEffect(() => {
    if (authQuery.isError) login();
  }, [authQuery.isError]);

  // Signed in but the org has no workspace yet → onboarding.
  useEffect(() => {
    if (authQuery.isSuccess && workspacesQuery.isSuccess && !active) {
      nav.replace("/onboarding");
    }
  }, [authQuery.isSuccess, workspacesQuery.isSuccess, active, nav]);

  if (authQuery.isLoading) return <Splash label="Signing in…" />;
  if (authQuery.isError) return <Splash label="Redirecting to sign-in…" />;
  if (workspacesQuery.isLoading || meQuery.isLoading) {
    return <Splash label="Loading your workspace…" />;
  }
  if (!active) return <Splash label="Setting up your workspace…" />;

  const auth = authQuery.data!;
  const value: SessionValue = {
    organizationId: auth.organizationId,
    userId: auth.userId,
    user: auth.user,
    workspaces,
    activeWorkspace: active,
    activeWorkspaceId: active.id,
    // Fail-open on a permissions blip (null-ish): the api + page guards remain
    // the real boundary, so the nav never strands a member with an empty rail.
    permissions: new Set(meQuery.data?.permissions ?? []),
    isOwner: meQuery.data?.isOwner ?? false,
    setActiveWorkspace,
  };

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}
