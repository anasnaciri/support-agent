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
import {
  mergeWorkspaces,
  surfaceHomeForKind,
  type RbacPermissionId,
  type UnifiedWorkspace,
} from "@support-agent/dashboard-contracts";

import {
  getMeSession,
  getSupplierSession,
  getSupplierWorkspaces,
  getWorkspaces,
} from "./api-client";
import { UnauthorizedError } from "./errors";
import {
  getAuthSession,
  isOnboardingRequired,
  login,
  type Whoami,
} from "./auth/session-api";
import type { SessionUser } from "./auth/types";
import { qk, workspaceScopedKeyPrefixes } from "./query-keys";
import { WORKSPACE_COOKIE, pickActiveWorkspace } from "./workspace";
import { useAppNavigate, usePathname } from "./navigation";

// The client-side replacement for the RSC `getDashboardContext` gate: bootstrap
// the WorkOS session (BFF whoami), the workspaces, the active workspace
// (localStorage, default-tolerant), and the member's effective permissions for
// nav gating. Gates the whole authed area — children only render once resolved.
//
// UNIFIED switcher: a person can be a MERCHANT in one workspace and a SUPPLIER in
// another (org-independent binding). We source two lists — the org-scoped
// merchant workspaces and the binding-anchored supplier workspaces — and merge
// them, each entry tagged by kind. The surface/mode is a property of the ACTIVE
// workspace, so permissions load from POST /me/session (merchant) or GET
// /supplier/session (supplier) depending on which kind is active.

const readStoredWorkspace = (): string | undefined => {
  try {
    // A supplier notification deep-link (?w=<tenantId>) pins the workspace so a
    // multi-merchant supplier lands on the right one; it wins over the stored
    // pick and is persisted so it sticks after the param is gone. A ?w the user
    // isn't bound to is harmless — pickActiveWorkspace falls back to default.
    const fromUrl = new URLSearchParams(window.location.search).get("w");
    if (fromUrl) {
      try {
        localStorage.setItem(WORKSPACE_COOKIE, fromUrl);
      } catch {
        /* private mode */
      }
      return fromUrl;
    }
    return localStorage.getItem(WORKSPACE_COOKIE) ?? undefined;
  } catch {
    return undefined;
  }
};

export interface SessionValue {
  readonly organizationId: string;
  readonly userId: string;
  readonly user: SessionUser;
  readonly workspaces: ReadonlyArray<UnifiedWorkspace>;
  readonly activeWorkspace: UnifiedWorkspace;
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

export const shouldStartLoginForAuthError = (error: unknown): boolean =>
  error instanceof UnauthorizedError;

export type WorkspaceBootstrapRedirectTarget = "/onboarding" | "/no-access";

export const workspaceBootstrapRedirectTarget = (input: {
  readonly bootstrapReady: boolean;
  readonly listsSettled: boolean;
  readonly hasActiveWorkspace: boolean;
  readonly merchantWorkspaceCount: number;
  readonly merchantProbeLoading: boolean;
}): WorkspaceBootstrapRedirectTarget | null => {
  if (!input.bootstrapReady || !input.listsSettled) return null;
  if (input.hasActiveWorkspace) return null;
  if (input.merchantProbeLoading) return null;
  return input.merchantWorkspaceCount > 0 ? "/no-access" : "/onboarding";
};

export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const nav = useAppNavigate();
  const pathname = usePathname() ?? "/";
  const [storedId, setStoredId] = useState<string | undefined>(
    readStoredWorkspace,
  );

  const authQuery = useQuery<Whoami>({
    queryKey: qk.authSession,
    queryFn: getAuthSession,
    retry: false,
    staleTime: 60_000,
  });

  // Authenticated but org-less → onboarding. Detected before the workspaces
  // fetch (which would 401 without an org).
  const needsOnboarding =
    authQuery.isSuccess && isOnboardingRequired(authQuery.data);

  const bootstrapReady = authQuery.isSuccess && !needsOnboarding;

  // Org-scoped merchant workspaces (the current WorkOS org).
  const workspacesQuery = useQuery({
    queryKey: qk.workspaces,
    queryFn: () => getWorkspaces(),
    enabled: bootstrapReady,
  });
  // Binding-anchored supplier workspaces (cross-org). This call also completes
  // the cross-tenant bootstrap server-side; staleTime keeps it from re-running
  // (and re-hitting WorkOS) on every render.
  const supplierWorkspacesQuery = useQuery({
    queryKey: qk.supplierWorkspaces,
    queryFn: () => getSupplierWorkspaces(),
    enabled: bootstrapReady,
    staleTime: 300_000,
  });

  const merchantWorkspaces = workspacesQuery.data?.workspaces ?? [];
  const supplierWorkspaces = supplierWorkspacesQuery.data?.workspaces ?? [];

  // Probe merchant access on the org's default workspace: only if the user is a
  // real merchant there do we surface the org's merchant workspaces (else the
  // org-scoped list would over-list to a pure supplier who merely belongs to the
  // merchant's WorkOS org). When the active workspace IS this default, the query
  // below dedupes with it (same key).
  const merchantDefaultId = merchantWorkspaces[0]?.id;
  const merchantMeQuery = useQuery({
    queryKey: merchantDefaultId ? qk.me(merchantDefaultId) : ["me", "no-merchant"],
    queryFn: () => getMeSession({ workspaceId: merchantDefaultId! }),
    enabled: Boolean(merchantDefaultId),
  });
  const isMerchant = (merchantMeQuery.data?.permissions ?? []).includes(
    "tickets.view",
  );

  const workspaces = useMemo(
    () => mergeWorkspaces(merchantWorkspaces, supplierWorkspaces, isMerchant),
    [merchantWorkspaces, supplierWorkspaces, isMerchant],
  );
  const active = useMemo(
    () => pickActiveWorkspace(workspaces, storedId) as UnifiedWorkspace | null,
    [workspaces, storedId],
  );
  const activeIsSupplier = active?.kind === "supplier";

  // Permissions follow the active workspace's kind. Merchant → POST /me/session
  // (org-resolved). Supplier → GET /supplier/session (binding-anchored; the
  // merchant endpoint would 404 for a different org's tenant).
  const activeMeQuery = useQuery({
    queryKey: active && !activeIsSupplier ? qk.me(active.id) : ["me", "none"],
    queryFn: () => getMeSession({ workspaceId: active!.id }),
    enabled: Boolean(active) && !activeIsSupplier,
  });
  const activeSupplierSessionQuery = useQuery({
    queryKey:
      active && activeIsSupplier
        ? qk.supplierSession(active.id)
        : ["supplier-session", "none"],
    queryFn: () => getSupplierSession({ workspaceId: active!.id }),
    enabled: Boolean(active) && activeIsSupplier,
  });
  const activePerms = activeIsSupplier
    ? activeSupplierSessionQuery.data
    : activeMeQuery.data;

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
      // Route to the target's surface. Switching INTO a supplier workspace →
      // the portal; switching a merchant workspace while on the supplier portal
      // → back to the merchant home. Merchant→merchant stays on the current
      // route (its data just refetches under the new workspace).
      const target = workspaces.find((w) => w.id === id);
      if (target?.kind === "supplier") {
        nav.replace(surfaceHomeForKind("supplier"));
      } else if (pathname.startsWith("/supplier")) {
        nav.replace(surfaceHomeForKind("merchant"));
      }
    },
    [queryClient, workspaces, nav, pathname],
  );

  // No session → into the WorkOS handshake (full-page). The global query
  // error handler also does this; here we cover the initial-load 401.
  useEffect(() => {
    if (authQuery.isError && shouldStartLoginForAuthError(authQuery.error)) {
      login();
    }
  }, [authQuery.error, authQuery.isError]);

  // Authenticated but no org yet (brand-new self-service user) → onboarding,
  // before the workspace fetch that would 401 without an org.
  useEffect(() => {
    if (needsOnboarding && pathname !== "/onboarding") {
      nav.replace("/onboarding");
    }
  }, [needsOnboarding, nav, pathname]);

  // Both workspace lists resolved but the user has NO workspace of either kind
  // → onboarding. Gated on both queries settling so a supplier-only user isn't
  // bounced while their binding list is still loading.
  const listsSettled =
    workspacesQuery.isSuccess &&
    (supplierWorkspacesQuery.isSuccess || supplierWorkspacesQuery.isError);
  const workspaceRedirectTarget = workspaceBootstrapRedirectTarget({
    bootstrapReady,
    listsSettled,
    hasActiveWorkspace: Boolean(active),
    merchantWorkspaceCount: merchantWorkspaces.length,
    merchantProbeLoading: Boolean(merchantDefaultId) && merchantMeQuery.isLoading,
  });
  useEffect(() => {
    if (workspaceRedirectTarget && pathname !== workspaceRedirectTarget) {
      nav.replace(workspaceRedirectTarget);
    }
  }, [nav, pathname, workspaceRedirectTarget]);

  if (authQuery.isLoading) return <Splash label="Signing in…" />;
  if (authQuery.isError) {
    return (
      <Splash
        label={
          shouldStartLoginForAuthError(authQuery.error)
            ? "Redirecting to sign-in…"
            : "Unable to load your session. Refresh to try again."
        }
      />
    );
  }
  if (needsOnboarding) return <Splash label="Setting up your workspace…" />;
  // Wait for both lists + the merchant probe (so the merged list + active are
  // final before we resolve permissions) and the active-workspace permissions.
  if (
    workspacesQuery.isLoading ||
    supplierWorkspacesQuery.isLoading ||
    (Boolean(merchantDefaultId) && merchantMeQuery.isLoading)
  ) {
    return <Splash label="Loading your workspace…" />;
  }
  if (!active) return <Splash label="Setting up your workspace…" />;
  if (activeIsSupplier ? activeSupplierSessionQuery.isLoading : activeMeQuery.isLoading) {
    return <Splash label="Loading your workspace…" />;
  }

  const auth = authQuery.data!;
  // Narrowed: the needsOnboarding branches returned above.
  if (isOnboardingRequired(auth)) {
    return <Splash label="Setting up your workspace…" />;
  }
  const value: SessionValue = {
    organizationId: auth.organizationId,
    userId: auth.userId,
    user: auth.user,
    workspaces,
    activeWorkspace: active,
    activeWorkspaceId: active.id,
    // Fail-open on a permissions blip (null-ish): the api + page guards remain
    // the real boundary, so the nav never strands a member with an empty rail.
    permissions: new Set(activePerms?.permissions ?? []),
    isOwner: activePerms?.isOwner ?? false,
    setActiveWorkspace,
  };

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}
