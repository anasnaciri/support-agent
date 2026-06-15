import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionState } from "./session";
import { buildRefreshRedirect } from "./session-refresh";
import type { ShopifyCustomer, ShopifyOrder } from "@support-agent/agent-core";
import type {
  AgentOverrideRow,
  ApprovalDetail,
  ApprovalsFilter,
  RefundPolicyMode,
  ApprovalsListResult,
  AuditEntry,
  AuditFilter,
  CaseConversationThreadResult,
  CaseDetail,
  CaseEventsResult,
  CaseListRow,
  CatalogResponse,
  ConnectorConnectionView,
  KnowledgeDocumentSummaryView,
  KnowledgeDocumentView,
  LlmCredentialStatusResponse,
  ModelsResponse,
  OnboardingResult,
  Page,
  ShopifyAppGateView,
  CreateWorkspaceResult,
  TenantInfo,
  TenantSettingsView,
  TodaySummary,
  UsageDecisionRow,
  WorkspaceSummary,
  WorkspacesResponse,
  MePermissionsResponse,
  MembersResponse,
  RolesResponse,
  RbacPermissionDef,
  RbacPermissionId,
} from "@support-agent/dashboard-contracts";
import { dashboardUserDecisionUuid } from "./user-id";
import { parseMintDenial } from "./connect-denial";
import { WORKSPACE_COOKIE, pickActiveWorkspace } from "./workspace";
import { LEGAL_ACCEPTED_AT_KEY, hasAcceptedAtSignup } from "./legal-consent";
import { ONBOARDING_PATH, buildSignUpRedirect } from "./auth-redirect";

// The page a logged-out request landed on, stamped by middleware.ts into the
// `x-pathname` request header. Used to build a `returnTo` so re-auth lands the
// user back where they were. Null when middleware didn't run (e.g. an auth
// route excluded from the matcher) — callers fall back to the bare /sign-up.
const currentPathname = async (): Promise<string | null> => {
  const h = await headers();
  return h.get("x-pathname");
};

// ============================================================
// Dashboard → apps/api client (Path B)
// ============================================================
//
// The dashboard hosts on Cloudflare Workers and holds NO database / pg-boss /
// Effect runtime. Every read and write goes through apps/api's `/dashboard/*`
// endpoints. The dashboard authenticates the merchant via WorkOS, then calls
// the api with a shared service token + the asserted WorkOS org id (and, for
// writes, the manager's decision UUID). `server-only` keeps the token off the
// client bundle.

const trimSlash = (s: string): string => s.replace(/\/+$/, "");

const apiBase = (): string => {
  const v = process.env["DASHBOARD_API_BASE_URL"];
  if (!v || v.trim().length === 0) {
    throw new Error("DASHBOARD_API_BASE_URL is required (dashboard → api origin)");
  }
  return trimSlash(v.trim());
};

export interface DashboardContext {
  readonly organizationId: string;
  /** WorkOS user id. */
  readonly userId: string;
  /**
   * The WorkOS access token (RS256 JWT) forwarded to the api as the bearer
   * credential — the api verifies it and derives org + user from its claims
   * (S14). No shared service token, no asserted x-org-id/x-user-id.
   */
  readonly accessToken: string;
  /**
   * Stable manager UUID derived from the WorkOS user id. The api re-derives the
   * same value from the verified `sub`; kept here only for client-side display
   * (e.g. matching "you" in the members list), never sent as a header.
   */
  readonly userDecisionUuid: string;
  /** The signed-in user's email (the api's x-user-email). */
  readonly userEmail: string | null;
  /** The ACTIVE workspace (tenant row) — same value as workspaceId. */
  readonly tenantId: string;
  readonly tenantName: string;
  readonly workspaceId: string;
  /** Every workspace the org owns, default first (for the switcher). */
  readonly workspaces: ReadonlyArray<WorkspaceSummary>;
  /** The member's effective permissions for the ACTIVE workspace (nav gating). */
  readonly permissions: ReadonlySet<RbacPermissionId>;
  /** True when the member is an owner (all-access) of the active workspace. */
  readonly isOwner: boolean;
}

interface CallCtx {
  /** The verified WorkOS access token forwarded as the bearer credential. */
  readonly accessToken: string;
  /** The acting user's email — sent as x-user-email for reconcile/auto-claim. */
  readonly userEmail?: string | null;
  /** Pins the api call to one workspace; absent → the org's default. */
  readonly workspaceId?: string;
}

interface CallResult {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Low-level call. Adds auth headers, posts JSON, and returns the parsed body
 * with the status. Throws on auth-config failures (401) and server errors
 * (5xx); 4xx bodies (404 not-found, 400 validation, write result codes) are
 * returned for the caller to interpret. A 403 (org has no tenant) bounces to
 * onboarding — getDashboardContext normally catches that first.
 */
const call = async (
  path: string,
  opts: {
    readonly method?: "GET" | "POST";
    readonly body?: unknown;
    readonly ctx: CallCtx;
    /**
     * What a 403 means depends on the endpoint: for tenant-scoped reads it's
     * "org has no tenant" (→ /onboarding), but endpoints with their own 403
     * semantics (legal_acceptance_required) need the body back instead of a
     * drive-by redirect.
     */
    readonly on403?: "redirect" | "return";
  },
): Promise<CallResult> => {
  const headers: Record<string, string> = {
    authorization: `Bearer ${opts.ctx.accessToken}`,
  };
  if (opts.ctx.userEmail) headers["x-user-email"] = opts.ctx.userEmail;
  if (opts.ctx.workspaceId) headers["x-workspace-id"] = opts.ctx.workspaceId;
  if (opts.body !== undefined) headers["content-type"] = "application/json";

  const res = await fetch(`${apiBase()}/dashboard${path}`, {
    method: opts.method ?? "GET",
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    cache: "no-store",
  });

  if (res.status === 401 || res.status === 503) {
    throw new Error(`dashboard api auth/config error ${res.status} on ${path}`);
  }
  if (res.status === 403 && (opts.on403 ?? "redirect") === "redirect") {
    redirect("/onboarding");
  }
  if (res.status >= 500) {
    throw new Error(`dashboard api error ${res.status} on ${path}`);
  }
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const okBody = async (path: string, ctx: CallCtx): Promise<unknown> => {
  const { status, body } = await call(path, { ctx });
  if (status !== 200) {
    throw new Error(`dashboard api ${status} on ${path}`);
  }
  return body;
};

// ---- Tenant resolution / auth gate ----

const fetchTenant = async (
  accessToken: string,
): Promise<TenantInfo | null> => {
  const { status, body } = await call("/tenant", { ctx: { accessToken } });
  if (status !== 200) throw new Error(`dashboard api ${status} on /tenant`);
  return (body as { tenant: TenantInfo | null }).tenant;
};

const fetchWorkspaces = async (
  accessToken: string,
): Promise<WorkspacesResponse> => {
  const { status, body } = await call("/workspaces", { ctx: { accessToken } });
  if (status !== 200) throw new Error(`dashboard api ${status} on /workspaces`);
  return body as WorkspacesResponse;
};

// Reconcile any pending invite for this user + load their effective access for
// the active workspace. POST because it may write (the invite reconcile).
const fetchMeSession = async (ctx: CallCtx): Promise<MePermissionsResponse> => {
  const { status, body } = await call("/me/session", { method: "POST", ctx });
  if (status !== 200) throw new Error(`dashboard api ${status} on /me/session`);
  return body as MePermissionsResponse;
};

/** The workspace:id cookie, or undefined. */
const workspaceCookie = async (): Promise<string | undefined> => {
  const store = await cookies();
  return store.get(WORKSPACE_COOKIE)?.value;
};

/**
 * The gate every tenant-scoped page calls first. Redirects to /sign-up when
 * there's no session and /onboarding when the user has no org yet (a fresh
 * self-service signup) or their org has no tenant — onboarding provisions
 * the WorkOS org (if needed) and creates the tenant.
 *
 * Logged-out visitors land on the legal-gated /sign-up (not WorkOS-hosted
 * sign-in) so a brand-new user can't slip past the data-processing checkbox
 * (audit B2). Returning users use the "Sign in" link on that page. The
 * onboarding legal fallback + the api tenant-level connector gate remain the
 * airtight net for anyone who still reaches the hosted sign-up.
 */
export const getDashboardContext = async (): Promise<DashboardContext> => {
  const { disposition, session } = await getSessionState();
  // Expired access token with a sealed refreshToken (U1): bounce through the
  // refresh route handler (RSCs can't Set-Cookie) and land back here, instead
  // of destroying the user's context with a /sign-up round-trip.
  if (disposition === "refreshable") {
    redirect(buildRefreshRedirect(await currentPathname()));
  }
  const { user, organizationId, accessToken } = session;
  if (!user || !accessToken) redirect(buildSignUpRedirect(await currentPathname()));
  if (!organizationId) redirect(ONBOARDING_PATH);
  const { workspaces } = await fetchWorkspaces(accessToken);
  // The cookie is advisory — a stale value (deleted workspace) resolves to
  // the default instead of erroring, so a delete/switch race can't strand
  // the user. The cookie itself is rewritten on the next explicit switch.
  const active = pickActiveWorkspace(workspaces, await workspaceCookie());
  if (!active) redirect(ONBOARDING_PATH);
  const userDecisionUuid = dashboardUserDecisionUuid(user.id);
  const userEmail = user.email ?? null;
  // Reconcile any pending invite + load the member's effective access for the
  // active workspace, so pages/nav gate on real permissions (the api still
  // enforces independently — this only drives what the UI shows).
  const me = await fetchMeSession({
    accessToken,
    userEmail,
    workspaceId: active.id,
  });
  return {
    organizationId,
    userId: user.id,
    accessToken,
    userDecisionUuid,
    userEmail,
    tenantId: active.id,
    tenantName: active.name,
    workspaceId: active.id,
    workspaces,
    permissions: new Set(me.permissions),
    isOwner: me.isOwner,
  };
};

/**
 * Workspace list + active id for the app shell's switcher. Tolerant on
 * purpose: the root layout renders on auth/onboarding routes too, where
 * there is no session or no org — any failure means "no switcher", never a
 * redirect or a crash.
 */
export interface ShellWorkspaces {
  readonly workspaces: ReadonlyArray<WorkspaceSummary>;
  readonly activeWorkspaceId: string;
  /**
   * The member's effective permissions for the active workspace, for nav
   * gating. `null` → couldn't load (fail-open: the rail shows everything; the
   * api still enforces and pages redirect-guard).
   */
  readonly permissions: ReadonlyArray<RbacPermissionId> | null;
}

export const getShellWorkspaces = async (): Promise<ShellWorkspaces | null> => {
  try {
    const { session } = await getSessionState();
    const { user, organizationId, accessToken } = session;
    if (!user || !organizationId || !accessToken) return null;
    const { workspaces } = await fetchWorkspaces(accessToken);
    const active = pickActiveWorkspace(workspaces, await workspaceCookie());
    if (!active) return null;
    let permissions: ReadonlyArray<RbacPermissionId> | null = null;
    try {
      const me = await fetchMeSession({
        accessToken,
        userEmail: user.email ?? null,
        workspaceId: active.id,
      });
      permissions = me.permissions;
    } catch {
      // Fail-open: nav shows everything; the api + page guards still enforce.
    }
    return { workspaces, activeWorkspaceId: active.id, permissions };
  } catch {
    return null;
  }
};

export interface OrgContext {
  readonly userId: string;
  readonly userDecisionUuid: string;
  /** The verified WorkOS access token (may be org-less for a fresh signup). */
  readonly accessToken: string;
  /**
   * The user's WorkOS org, or null for a fresh self-service signup that
   * isn't in one yet. Onboarding provisions the org when this is null.
   */
  readonly organizationId: string | null;
  readonly email: string | null;
  readonly existingTenantId: string | null;
  /**
   * ISO timestamp of the user's legal acceptance captured at the self-hosted
   * /sign-up page (WorkOS user metadata), or null. When set, onboarding skips
   * its own legal checkbox — the user already consented at sign-up.
   */
  readonly legalAcceptedAt: string | null;
}

/**
 * For /onboarding: org context that does NOT require an existing org or
 * tenant. A brand-new self-service user has neither — onboarding creates
 * both. Only the session (a signed-in user) is required.
 */
export const requireOrganization = async (): Promise<OrgContext> => {
  const { disposition, session } = await getSessionState();
  if (disposition === "refreshable") {
    redirect(buildRefreshRedirect(await currentPathname()));
  }
  const { user, organizationId, accessToken } = session;
  // Legal-gated front door (audit B2) — see getDashboardContext.
  if (!user || !accessToken) redirect(buildSignUpRedirect(await currentPathname()));
  const tenant =
    organizationId && accessToken ? await fetchTenant(accessToken) : null;
  const metadata = user.metadata ?? {};
  const acceptedAt = metadata[LEGAL_ACCEPTED_AT_KEY] ?? null;
  return {
    userId: user.id,
    userDecisionUuid: dashboardUserDecisionUuid(user.id),
    accessToken,
    organizationId: organizationId ?? null,
    email: user.email ?? null,
    existingTenantId: tenant?.tenantId ?? null,
    legalAcceptedAt: hasAcceptedAtSignup(metadata) ? acceptedAt : null,
  };
};

// Write-result shapes (the action reads `.kind`; the api owns the union).
export interface ApprovalDecisionResultView {
  readonly kind: string;
}
export interface TakeOverOutcomeView {
  readonly kind: string;
  readonly canceledApprovals?: number;
}
export interface ResumeOutcomeView {
  readonly kind: string;
  readonly toStatus?: string;
  readonly status?: string;
}

export interface CaseShopifyPanels {
  readonly customer: ShopifyCustomer | null;
  readonly order: ShopifyOrder | null;
  readonly shopDomain: string | null;
}

// Supplier portal — the minimal privacy projection the api returns (no customer
// PII). Mirrors the db's SupplierEscalation{ListItem,Detail} shapes; redefined
// here because the dashboard (Path B) imports only agent-core + contracts.
export interface SupplierEscalationListItemView {
  readonly id: string;
  readonly caseId: string;
  readonly problem: string;
  readonly orderRef: string | null;
  readonly shipCity: string | null;
  readonly shipCountry: string | null;
  readonly trackingNumber: string | null;
  readonly status: string;
  readonly createdAt: string;
}
export interface SupplierEscalationDetailView
  extends SupplierEscalationListItemView {
  readonly note: string | null;
  readonly proposedResolution: string | null;
}

// ============================================================
// Typed endpoint methods. Reads take a Ctx (org); writes take org + decision
// UUID (DashboardContext satisfies both).
// ============================================================

export const api = {
  // ---- Reads ----
  today: (ctx: CallCtx): Promise<TodaySummary> =>
    okBody("/today", ctx) as Promise<TodaySummary>,

  cases: (
    ctx: CallCtx,
    page: number,
    limit: number,
    q?: string,
  ): Promise<Page<CaseListRow>> => {
    const qs = new URLSearchParams({ page: String(page), limit: String(limit) });
    const trimmed = q?.trim();
    if (trimmed) qs.set("q", trimmed);
    return okBody(`/cases?${qs.toString()}`, ctx) as Promise<Page<CaseListRow>>;
  },

  caseDetail: async (ctx: CallCtx, id: string): Promise<CaseDetail | null> => {
    const { status, body } = await call(`/cases/${encodeURIComponent(id)}`, { ctx });
    if (status === 404) return null;
    if (status !== 200) throw new Error(`dashboard api ${status} on /cases/:id`);
    return body as CaseDetail;
  },

  caseConversationThread: async (
    ctx: CallCtx,
    id: string,
  ): Promise<CaseConversationThreadResult | null> => {
    const { status, body } = await call(
      `/cases/${encodeURIComponent(id)}/conversation-thread`,
      { ctx },
    );
    if (status === 404) return null;
    if (status !== 200) {
      throw new Error(
        `dashboard api ${status} on /cases/:id/conversation-thread`,
      );
    }
    return body as CaseConversationThreadResult;
  },

  caseShopify: async (
    ctx: CallCtx,
    id: string,
  ): Promise<CaseShopifyPanels | null> => {
    const { status, body } = await call(
      `/cases/${encodeURIComponent(id)}/shopify`,
      { ctx },
    );
    if (status === 404) return null;
    if (status !== 200) throw new Error(`dashboard api ${status} on /cases/:id/shopify`);
    return body as CaseShopifyPanels;
  },

  caseEvents: async (
    ctx: CallCtx,
    id: string,
    since: string,
  ): Promise<CaseEventsResult | null> => {
    const { status, body } = await call(
      `/cases/${encodeURIComponent(id)}/events?since=${encodeURIComponent(since)}`,
      { ctx },
    );
    if (status === 404) return null;
    if (status !== 200) throw new Error(`dashboard api ${status} on /cases/:id/events`);
    return body as CaseEventsResult;
  },

  approvals: (
    ctx: CallCtx,
    filter: ApprovalsFilter,
    page: number,
    limit: number,
  ): Promise<ApprovalsListResult> => {
    const qs = new URLSearchParams();
    for (const v of filter.status ?? []) qs.append("status", v);
    for (const v of filter.risk ?? []) qs.append("risk", v);
    for (const v of filter.tool ?? []) qs.append("tool", v);
    for (const v of filter.agent ?? []) qs.append("agent", v);
    qs.set("page", String(page));
    qs.set("limit", String(limit));
    return okBody(`/approvals?${qs.toString()}`, ctx) as Promise<ApprovalsListResult>;
  },

  approvalDetail: async (
    ctx: CallCtx,
    id: string,
  ): Promise<ApprovalDetail | null> => {
    const { status, body } = await call(`/approvals/${encodeURIComponent(id)}`, {
      ctx,
    });
    if (status === 404) return null;
    if (status !== 200) throw new Error(`dashboard api ${status} on /approvals/:id`);
    return body as ApprovalDetail;
  },

  audit: (
    ctx: CallCtx,
    filter: AuditFilter,
    page: number,
    limit: number,
  ): Promise<Page<AuditEntry>> => {
    const qs = new URLSearchParams();
    if (filter.action) qs.set("action", filter.action);
    if (filter.actor) qs.set("actor", filter.actor);
    qs.set("page", String(page));
    qs.set("limit", String(limit));
    return okBody(`/audit?${qs.toString()}`, ctx) as Promise<Page<AuditEntry>>;
  },

  connections: async (
    ctx: CallCtx,
  ): Promise<ReadonlyArray<ConnectorConnectionView>> =>
    (
      (await okBody("/connections", ctx)) as {
        connections: ReadonlyArray<ConnectorConnectionView>;
      }
    ).connections,

  shopifyApp: (ctx: CallCtx): Promise<ShopifyAppGateView> =>
    okBody("/shopify-app", ctx) as Promise<ShopifyAppGateView>,

  usage: async (
    ctx: CallCtx,
    start: string,
    end: string,
  ): Promise<ReadonlyArray<UsageDecisionRow>> =>
    (
      (await okBody(
        `/usage?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
        ctx,
      )) as { rows: ReadonlyArray<UsageDecisionRow> }
    ).rows,

  agentOverrides: async (
    ctx: CallCtx,
  ): Promise<ReadonlyArray<AgentOverrideRow>> =>
    (
      (await okBody("/agent-overrides", ctx)) as {
        overrides: ReadonlyArray<AgentOverrideRow>;
      }
    ).overrides,

  catalog: (ctx: CallCtx): Promise<CatalogResponse> =>
    okBody("/catalog", ctx) as Promise<CatalogResponse>,

  models: (ctx: CallCtx): Promise<ModelsResponse> =>
    okBody("/models", ctx) as Promise<ModelsResponse>,

  llmStatus: (ctx: CallCtx): Promise<LlmCredentialStatusResponse> =>
    okBody("/llm", ctx) as Promise<LlmCredentialStatusResponse>,

  settings: (ctx: CallCtx): Promise<TenantSettingsView> =>
    okBody("/settings", ctx) as Promise<TenantSettingsView>,

  shopCurrency: (
    ctx: CallCtx,
  ): Promise<{ readonly currencyCode: string | null }> =>
    okBody("/shop-currency", ctx) as Promise<{
      readonly currencyCode: string | null;
    }>,

  // ---- Writes ----
  onboarding: async (
    ctx: CallCtx,
    input: {
      readonly name: string;
      readonly notificationEmail: string;
      readonly legalAccepted: boolean;
    },
  ): Promise<{ status: number; result: OnboardingResult | null }> => {
    const { status, body } = await call("/onboarding", {
      method: "POST",
      body: input,
      ctx,
    });
    return { status, result: status === 200 ? (body as OnboardingResult) : null };
  },

  acceptLegal: (ctx: CallCtx): Promise<CallResult> =>
    call("/legal-acceptance", { method: "POST", ctx }),

  /**
   * Irreversibly delete the whole account: EVERY workspace the org owns,
   * then the WorkOS org + deletion email (worker).
   */
  deleteAccount: (ctx: CallCtx): Promise<CallResult> =>
    call("/account/delete", { method: "POST", ctx }),

  // ---- Workspaces ----
  workspaces: (ctx: CallCtx): Promise<WorkspacesResponse> =>
    okBody("/workspaces", ctx) as Promise<WorkspacesResponse>,

  createWorkspace: async (
    ctx: CallCtx,
    input: { readonly name: string; readonly notificationEmail: string },
  ): Promise<{
    status: number;
    result: CreateWorkspaceResult | null;
    error: string | null;
  }> => {
    const { status, body } = await call("/workspaces", {
      method: "POST",
      body: input,
      ctx,
      on403: "return", // legal_acceptance_required — caller routes to legal
    });
    return {
      status,
      result: status === 200 ? (body as CreateWorkspaceResult) : null,
      error:
        status === 200
          ? null
          : ((body as { error?: string } | null)?.error ?? "unknown"),
    };
  },

  renameWorkspace: (
    ctx: CallCtx,
    workspaceId: string,
    name: string,
  ): Promise<CallResult> =>
    call(`/workspaces/${encodeURIComponent(workspaceId)}/rename`, {
      method: "POST",
      body: { name },
      ctx,
    }),

  /** Delete ONE workspace; the org and sibling workspaces survive. */
  deleteWorkspace: (ctx: CallCtx, workspaceId: string): Promise<CallResult> =>
    call(`/workspaces/${encodeURIComponent(workspaceId)}/delete`, {
      method: "POST",
      ctx,
    }),

  setAgentModel: (ctx: CallCtx, agentId: string, model: string): Promise<CallResult> =>
    call(`/agents/${encodeURIComponent(agentId)}/model`, {
      method: "POST",
      body: { model },
      ctx,
    }),

  clearAgentModel: (ctx: CallCtx, agentId: string): Promise<CallResult> =>
    call(`/agents/${encodeURIComponent(agentId)}/model/clear`, {
      method: "POST",
      ctx,
    }),

  setAgentSystemPrompt: (
    ctx: CallCtx,
    agentId: string,
    systemPrompt: string,
  ): Promise<CallResult> =>
    call(`/agents/${encodeURIComponent(agentId)}/system-prompt`, {
      method: "POST",
      body: { systemPrompt },
      ctx,
    }),

  clearAgentSystemPrompt: (
    ctx: CallCtx,
    agentId: string,
  ): Promise<CallResult> =>
    call(`/agents/${encodeURIComponent(agentId)}/system-prompt/clear`, {
      method: "POST",
      ctx,
    }),

  setAgentToolPermission: (
    ctx: CallCtx,
    agentId: string,
    tool: string,
    permission: "ask" | "allow",
  ): Promise<CallResult> =>
    call(`/agents/${encodeURIComponent(agentId)}/tool-permission`, {
      method: "POST",
      body: { tool, permission },
      ctx,
    }),

  clearAgentToolPermission: (
    ctx: CallCtx,
    agentId: string,
    tool: string,
  ): Promise<CallResult> =>
    call(`/agents/${encodeURIComponent(agentId)}/tool-permission/clear`, {
      method: "POST",
      body: { tool },
      ctx,
    }),

  knowledge: async (
    ctx: CallCtx,
  ): Promise<ReadonlyArray<KnowledgeDocumentSummaryView>> =>
    (
      (await okBody("/knowledge", ctx)) as {
        documents: ReadonlyArray<KnowledgeDocumentSummaryView>;
      }
    ).documents,

  knowledgeDoc: async (
    ctx: CallCtx,
    id: string,
  ): Promise<KnowledgeDocumentView | null> => {
    const { status, body } = await call(
      `/knowledge/${encodeURIComponent(id)}`,
      { ctx },
    );
    if (status !== 200) return null;
    return (body as { document: KnowledgeDocumentView }).document;
  },

  createKnowledge: (
    ctx: CallCtx,
    input:
      | { readonly title: string; readonly sourceType: "text"; readonly content: string }
      | { readonly title: string; readonly sourceType: "url"; readonly sourceUrl: string },
  ): Promise<CallResult> =>
    call("/knowledge", { method: "POST", body: input, ctx }),

  updateKnowledge: (
    ctx: CallCtx,
    id: string,
    input: { readonly title?: string; readonly content?: string },
  ): Promise<CallResult> =>
    call(`/knowledge/${encodeURIComponent(id)}`, {
      method: "POST",
      body: input,
      ctx,
    }),

  deleteKnowledge: (ctx: CallCtx, id: string): Promise<CallResult> =>
    call(`/knowledge/${encodeURIComponent(id)}/delete`, {
      method: "POST",
      ctx,
    }),

  resyncKnowledge: (ctx: CallCtx, id: string): Promise<CallResult> =>
    call(`/knowledge/${encodeURIComponent(id)}/resync`, {
      method: "POST",
      ctx,
    }),

  connectLlm: (
    ctx: CallCtx,
    input: {
      readonly provider: string;
      readonly apiKey: string;
      readonly baseURL?: string;
    },
  ): Promise<CallResult> =>
    call("/llm", { method: "POST", body: input, ctx }),

  revokeLlm: (ctx: CallCtx): Promise<CallResult> =>
    call("/llm/revoke", { method: "POST", ctx }),

  setRefundPolicy: (
    ctx: CallCtx,
    input: {
      readonly currencyCode: string;
      readonly askAboveMinorUnits: number;
      readonly denyAboveMinorUnits: number;
      readonly mode: RefundPolicyMode;
    },
  ): Promise<CallResult> =>
    call("/refund-policy", { method: "POST", body: input, ctx }),

  setSupplierSheet: (
    ctx: CallCtx,
    input: {
      readonly spreadsheetId: string;
      readonly range: string;
      readonly description: string | null;
    },
  ): Promise<CallResult> =>
    call("/supplier-sheet", { method: "POST", body: input, ctx }),

  clearSupplierSheet: (ctx: CallCtx): Promise<CallResult> =>
    call("/supplier-sheet/clear", { method: "POST", ctx }),

  disconnect: (ctx: CallCtx, provider: string): Promise<CallResult> =>
    call(`/connections/${encodeURIComponent(provider)}/disconnect`, {
      method: "POST",
      ctx,
    }),

  // Connect a generic IMAP/SMTP mailbox. Unlike the OAuth connectors there's
  // no redirect: the credentials are POSTed to the api, which connectivity-
  // checks both servers before storing. Plaintext app-password transits
  // dashboard → api over TLS; the api encrypts it at rest.
  connectImap: (
    ctx: CallCtx,
    input: {
      readonly mailbox: string;
      readonly password: string;
      readonly imapHost: string;
      readonly imapPort?: number;
      readonly imapSecure?: boolean;
      readonly smtpHost: string;
      readonly smtpPort?: number;
      readonly smtpSecure?: boolean;
      readonly user?: string;
    },
  ): Promise<CallResult> =>
    // on403 return: the action maps it to its legal_acceptance_required
    // message (the blanket /onboarding redirect made that branch dead code).
    call("/connections/imap", {
      method: "POST",
      body: input,
      ctx,
      on403: "return",
    }),

  // Autodiscover a mailbox's IMAP/SMTP server settings from just the
  // address (api-side: ISPDB + MX heuristics + DNS-checked guesses), so the
  // connect form can hide host/port fields from non-technical merchants.
  // Read-only — nothing is persisted.
  discoverImap: (
    ctx: CallCtx,
    input: { readonly email: string },
  ): Promise<CallResult> =>
    call("/connections/imap/discover", { method: "POST", body: input, ctx }),

  // Mint a signed Telegram linking deep link (t.me/<bot>?start=<token>)
  // for the authenticated tenant. The merchant opens it and presses
  // Start; the api's bot webhook binds their chat. 503 → bot not
  // configured on this deployment.
  connectTelegram: (ctx: CallCtx): Promise<CallResult> =>
    call("/connections/telegram", {
      method: "POST",
      ctx,
      on403: "return",
    }),

  // Mint a signed install grant for the authenticated tenant and get the
  // provider OAuth install URL (5th-audit #2). The tenant is derived
  // server-side from the session, never client-supplied.
  connectUrl: async (
    ctx: CallCtx,
    provider: string,
  ): Promise<
    | { readonly url: string }
    | { readonly alreadyConnected: { readonly mailbox: string | null } }
    | { readonly denied: string }
  > => {
    const { status, body } = await call(
      `/connect/${encodeURIComponent(provider)}`,
      { method: "POST", ctx },
    );
    // One mailbox per provider per store — the api refuses to mint an
    // install grant while one is connected.
    if (
      status === 409 &&
      (body as { error?: unknown })?.error === "already_connected"
    ) {
      const mailbox = (body as { mailbox?: unknown }).mailbox;
      return {
        alreadyConnected: {
          mailbox: typeof mailbox === "string" ? mailbox : null,
        },
      };
    }
    // The api refuses to mint a Shopify grant for a workspace with no app
    // credentials of its own (pilot not provisioned / revoked / no app
    // configured). Surfaced as a friendly banner, not a 500 page.
    const denied = parseMintDenial(status, body);
    if (denied) return { denied };
    if (status !== 200 || typeof (body as { url?: unknown })?.url !== "string") {
      throw new Error(`dashboard api ${status} on /connect/${provider}`);
    }
    return body as { url: string };
  },

  approveApproval: async (
    ctx: CallCtx,
    id: string,
    approvedInput?: unknown,
  ): Promise<ApprovalDecisionResultView> => {
    const { body } = await call(`/approvals/${encodeURIComponent(id)}/approve`, {
      method: "POST",
      body: approvedInput !== undefined ? { approvedInput } : {},
      ctx,
    });
    return (body as ApprovalDecisionResultView | null) ?? { kind: "error" };
  },

  rejectApproval: async (
    ctx: CallCtx,
    id: string,
  ): Promise<ApprovalDecisionResultView> => {
    const { body } = await call(`/approvals/${encodeURIComponent(id)}/reject`, {
      method: "POST",
      ctx,
    });
    return (body as ApprovalDecisionResultView | null) ?? { kind: "error" };
  },

  takeover: async (
    ctx: CallCtx,
    caseId: string,
    reason?: string,
  ): Promise<TakeOverOutcomeView> => {
    const { body } = await call(`/cases/${encodeURIComponent(caseId)}/takeover`, {
      method: "POST",
      body: reason !== undefined ? { reason } : {},
      ctx,
    });
    return (body as TakeOverOutcomeView | null) ?? { kind: "error" };
  },

  resume: async (
    ctx: CallCtx,
    caseId: string,
    reason?: string,
  ): Promise<ResumeOutcomeView> => {
    const { body } = await call(`/cases/${encodeURIComponent(caseId)}/resume`, {
      method: "POST",
      body: reason !== undefined ? { reason } : {},
      ctx,
    });
    return (body as ResumeOutcomeView | null) ?? { kind: "error" };
  },

  // Resume + an immediate `case.resumed` tick — the agent retries now
  // instead of waiting for the customer's next reply.
  retry: async (ctx: CallCtx, caseId: string): Promise<ResumeOutcomeView> => {
    const { body } = await call(`/cases/${encodeURIComponent(caseId)}/retry`, {
      method: "POST",
      ctx,
    });
    return (body as ResumeOutcomeView | null) ?? { kind: "error" };
  },

  // ---- Members & roles (members.manage) ----
  members: async (ctx: CallCtx): Promise<MembersResponse> =>
    okBody("/members", ctx) as Promise<MembersResponse>,

  roles: async (ctx: CallCtx): Promise<RolesResponse> =>
    okBody("/roles", ctx) as Promise<RolesResponse>,

  permissionCatalog: async (
    ctx: CallCtx,
  ): Promise<ReadonlyArray<RbacPermissionDef>> =>
    (
      (await okBody("/permission-catalog", ctx)) as {
        permissions: ReadonlyArray<RbacPermissionDef>;
      }
    ).permissions,

  inviteMember: (
    ctx: CallCtx,
    input: {
      readonly email: string;
      readonly roleId: string;
      readonly workosInvitationId?: string;
    },
  ): Promise<CallResult> =>
    call("/members/invite", { method: "POST", body: input, ctx }),

  setMemberRole: (
    ctx: CallCtx,
    userDecisionUuid: string,
    roleId: string,
  ): Promise<CallResult> =>
    call(`/members/${encodeURIComponent(userDecisionUuid)}/role`, {
      method: "POST",
      body: { roleId },
      ctx,
    }),

  removeMember: (ctx: CallCtx, userDecisionUuid: string): Promise<CallResult> =>
    call(`/members/${encodeURIComponent(userDecisionUuid)}/remove`, {
      method: "POST",
      ctx,
    }),

  revokeInvitation: (ctx: CallCtx, invitationId: string): Promise<CallResult> =>
    call(`/invitations/${encodeURIComponent(invitationId)}/revoke`, {
      method: "POST",
      ctx,
    }),

  createRole: (ctx: CallCtx, name: string): Promise<CallResult> =>
    call("/roles", { method: "POST", body: { name }, ctx }),

  renameRole: (ctx: CallCtx, roleId: string, name: string): Promise<CallResult> =>
    call(`/roles/${encodeURIComponent(roleId)}/rename`, {
      method: "POST",
      body: { name },
      ctx,
    }),

  setRolePermissions: (
    ctx: CallCtx,
    roleId: string,
    permissionIds: ReadonlyArray<RbacPermissionId>,
  ): Promise<CallResult> =>
    call(`/roles/${encodeURIComponent(roleId)}/permissions`, {
      method: "POST",
      body: { permissionIds },
      ctx,
    }),

  deleteRole: (ctx: CallCtx, roleId: string): Promise<CallResult> =>
    call(`/roles/${encodeURIComponent(roleId)}/delete`, {
      method: "POST",
      ctx,
    }),

  // ---- Supplier portal ----
  supplierCases: async (
    ctx: CallCtx,
  ): Promise<ReadonlyArray<SupplierEscalationListItemView>> =>
    (
      (await okBody("/supplier/cases", ctx)) as {
        cases: ReadonlyArray<SupplierEscalationListItemView>;
      }
    ).cases,

  supplierCase: async (
    ctx: CallCtx,
    id: string,
  ): Promise<SupplierEscalationDetailView | null> => {
    const { status, body } = await call(
      `/supplier/cases/${encodeURIComponent(id)}`,
      { ctx },
    );
    if (status === 404) return null;
    if (status !== 200) {
      throw new Error(`dashboard api ${status} on /supplier/cases/:id`);
    }
    return body as SupplierEscalationDetailView;
  },

  supplierUpdate: (
    ctx: CallCtx,
    id: string,
    input: {
      readonly note: string;
      readonly proposedResolution?: string | null;
    },
  ): Promise<CallResult> =>
    call(`/supplier/cases/${encodeURIComponent(id)}/update`, {
      method: "POST",
      body: input,
      ctx,
      on403: "return",
    }),

  inviteSupplier: (
    ctx: CallCtx,
    input: {
      readonly email: string;
      readonly name?: string;
      readonly workosInvitationId?: string;
    },
  ): Promise<CallResult> =>
    call("/supplier/invite", { method: "POST", body: input, ctx }),
};
