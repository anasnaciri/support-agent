import type {
  ShopifyCustomer,
  ShopifyOrder,
  ShopifyOrderRefundContext,
} from "@support-agent/agent-core";
import type {
  AgentOverrideRow,
  ApprovalDetail,
  ApprovalsFilter,
  RefundPolicyMode,
  CustomsDutiesPayerView,
  ReturnShippingPayerView,
  RefundMethodView,
  FactReferenceEntryView,
  FactReferencesResponse,
  ResolvedReferencesView,
  DiscountPolicyMode,
  ApprovalsListResult,
  AuditEntry,
  AuditFilter,
  TicketAttachmentSummary,
  TicketConversationThreadResult,
  TicketDetail,
  TicketEventsResult,
  TicketTrackingResult,
  TicketListRow,
  TicketsFilter,
  BlockedSendersView,
  CatalogResponse,
  ConnectorConnectionView,
  KnowledgeDocumentSummaryView,
  KnowledgeDocumentView,
  LlmCredentialStatusResponse,
  ModelsResponse,
  OnboardingResult,
  Page,
  ResolutionPolicyView,
  ResolutionScenarioView,
  ShopifyAppGateView,
  CreateWorkspaceResult,
  TenantInfo,
  TenantSettingsView,
  TodaySummary,
  UsageDecisionRow,
  WorkspaceSummary,
  WorkspacesResponse,
  OnboardingStateView,
  OnboardingAdvanceInput,
  StoreProfileView,
  MePermissionsResponse,
  MembersResponse,
  RolesResponse,
  RbacPermissionDef,
  RbacPermissionId,
} from "@support-agent/dashboard-contracts";
import { parseMintDenial } from "./connect-denial";
import {
  ApiConfigError,
  ApiError,
  LegalRequiredError,
  NoTenantError,
  UnauthorizedError,
} from "./errors";

// ============================================================
// Dashboard SPA → apps/api client (Path B, BFF cookie session)
// ============================================================
//
// The Vite SPA calls apps/api directly from the browser with the httpOnly
// session cookie apps/api minted at OAuth callback (`credentials:"include"`).
// It holds NO token in JS. This is the transport port of apps/dashboard's
// lib/api-client.ts: the ~60 typed endpoint methods below are unchanged; only
// `call()` moved from an RSC server-fetch (server-only + forwarded bearer +
// redirect()) to a browser fetch (cookie + typed thrown errors). Auth/tenant
// failures THROW (see ./errors); a global TanStack Query handler maps them to
// router navigations. The only per-call context is the active workspace id.

const trimSlash = (s: string): string => s.replace(/\/+$/u, "");

const apiBase = (): string => {
  const v = import.meta.env.VITE_API_BASE_URL;
  if (!v || v.trim().length === 0) {
    throw new Error("VITE_API_BASE_URL is required (SPA → api origin)");
  }
  return trimSlash(v.trim());
};

/** The only per-call context now: which workspace (tenant) to pin the call to. */
export interface CallCtx {
  readonly workspaceId?: string;
}

interface CallResult {
  readonly status: number;
  readonly body: unknown;
}

// Refresh the session at most once concurrently: on a 401 the api can re-mint
// the cookie from its sealed refresh token (POST /dashboard/auth/refresh), so a
// lapsed access token self-heals instead of bouncing the user to sign-in (U1).
let refreshInFlight: Promise<boolean> | null = null;
const tryRefresh = (): Promise<boolean> => {
  if (!refreshInFlight) {
    refreshInFlight = fetch(`${apiBase()}/dashboard/auth/refresh`, {
      method: "POST",
      credentials: "include",
      headers: { origin: window.location.origin },
    })
      .then((r) => r.ok)
      .catch(() => false)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
};

const rawCall = async (
  path: string,
  opts: {
    readonly method?: "GET" | "POST";
    readonly body?: unknown;
    readonly ctx: CallCtx;
  },
): Promise<CallResult> => {
  const headers: Record<string, string> = {};
  if (opts.ctx.workspaceId) headers["x-workspace-id"] = opts.ctx.workspaceId;
  if (opts.body !== undefined) headers["content-type"] = "application/json";

  const res = await fetch(`${apiBase()}/dashboard${path}`, {
    method: opts.method ?? "GET",
    headers,
    credentials: "include",
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
};

/**
 * Low-level call: sends the cookie, retries once after a silent refresh on 401,
 * then maps auth/tenant/config/server failures to thrown typed errors. 4xx
 * bodies the caller interprets (404 not-found, 400 validation, write result
 * codes) are returned. A 403 THROWS by default (NoTenant → onboarding /
 * LegalRequired → legal); `on403:"return"` hands the body back instead.
 */
const call = async (
  path: string,
  opts: {
    readonly method?: "GET" | "POST";
    readonly body?: unknown;
    readonly ctx: CallCtx;
    readonly on403?: "throw" | "return";
  },
): Promise<CallResult> => {
  let res = await rawCall(path, opts);
  if (res.status === 401) {
    const refreshed = await tryRefresh();
    if (refreshed) res = await rawCall(path, opts);
  }
  if (res.status === 401) throw new UnauthorizedError();
  if (res.status === 503) throw new ApiConfigError();
  if (res.status >= 500) {
    throw new ApiError(`dashboard api error ${res.status} on ${path}`, res.status);
  }
  if (res.status === 403 && (opts.on403 ?? "throw") === "throw") {
    const err = (res.body as { error?: string } | null)?.error;
    if (err === "legal_acceptance_required") throw new LegalRequiredError();
    if (err === "no_tenant_for_organization") throw new NoTenantError();
    throw new ApiError(
      `dashboard api forbidden${err ? ` (${err})` : ""} on ${path}`,
      403,
    );
  }
  return res;
};

/**
 * Recover a 502 as a discriminated outcome.
 *
 * The store-write endpoints (refund, cancel) answer 502 when SHOPIFY refused
 * the write — an upstream "no", not a fault in our api. But `call` throws on
 * any status >= 500, so those outcomes would reach the mutation's `onError`
 * and surface as "Something went wrong. Please try again." For a money write
 * that is actively dangerous: the operator must learn that nothing happened
 * and no money moved, not be left wondering whether it half-succeeded.
 *
 * Only 502 is recovered. A genuine 500/503 still throws — we don't know what
 * the server did, so we must not narrate an outcome.
 */
const recover502 = async <T extends { readonly kind: string }>(
  kind: T["kind"],
  run: () => Promise<T>,
): Promise<T> => {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ApiError && err.status === 502) return { kind } as T;
    throw err;
  }
};

const okBody = async (path: string, ctx: CallCtx): Promise<unknown> => {
  const { status, body } = await call(path, { ctx });
  if (status !== 200) {
    throw new ApiError(`dashboard api ${status} on ${path}`, status);
  }
  return body;
};

// ---- Bootstrap helpers (the RSC auth gate's job, now client-side) ----

/** The org's tenant (or null) — for the onboarding gate. */
export const getTenant = async (ctx: CallCtx = {}): Promise<TenantInfo | null> => {
  const { status, body } = await call("/tenant", { ctx, on403: "return" });
  if (status !== 200) throw new ApiError(`dashboard api ${status} on /tenant`, status);
  return (body as { tenant: TenantInfo | null }).tenant;
};

/** Every workspace the org owns (default first) — for the switcher + gate. */
export const getWorkspaces = async (
  ctx: CallCtx = {},
): Promise<WorkspacesResponse> =>
  okBody("/workspaces", ctx) as Promise<WorkspacesResponse>;

/**
 * Every merchant workspace the signed-in FULFILLMENT_OPERATOR is bound to, across all orgs
 * (identity-only; sends no x-workspace-id). Also completes the cross-tenant
 * bootstrap server-side. Feeds the unified switcher's fulfillment partner entries.
 */
export const getFulfillmentOperatorWorkspaces = async (
  ctx: CallCtx = {},
): Promise<WorkspacesResponse> =>
  okBody("/fulfillment-operator/workspaces", ctx) as Promise<WorkspacesResponse>;

/**
 * Binding-anchored fulfillmentOperator permissions for the ACTIVE workspace (needs
 * x-workspace-id). Used instead of POST /me/session when the active workspace is
 * a fulfillment partner one — that endpoint resolves via org and would 404 across orgs.
 */
export const getFulfillmentOperatorSession = async (
  ctx: CallCtx,
): Promise<MePermissionsResponse> =>
  okBody("/fulfillment-operator/session", ctx) as Promise<MePermissionsResponse>;

/**
 * Reconcile any pending invite + load the member's effective permissions for
 * the active workspace (POST because it may write the reconcile). Seeds the
 * permission set the nav gates on.
 */
export const getMeSession = async (
  ctx: CallCtx,
): Promise<MePermissionsResponse> => {
  const { status, body } = await call("/me/session", { method: "POST", ctx });
  if (status !== 200) {
    throw new ApiError(`dashboard api ${status} on /me/session`, status);
  }
  return body as MePermissionsResponse;
};

// Write-result shapes (the action reads `.kind`; the api owns the union).
export interface ApprovalDecisionResultView {
  readonly kind: string;
}
export interface TicketBundleDecisionResultView {
  readonly kind: string;
  readonly action?: "approve" | "reject";
  readonly count?: number;
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
export interface SetTicketStatusOutcomeView {
  readonly kind: string;
  readonly fromStatus?: string;
  readonly toStatus?: string;
  readonly status?: string;
  readonly canceledApprovals?: number;
}
export interface ResolveTicketOutcomeView {
  readonly kind: string;
}
export interface EscalateFulfillmentOperatorOutcomeView {
  readonly kind: string;
  readonly escalationId?: string;
  readonly fromStatus?: string;
}
export interface IssueRefundOutcomeView {
  readonly kind: string;
  readonly refundId?: string;
  readonly amount?: { readonly amount: string; readonly currencyCode: string };
  readonly createdAt?: string;
  readonly orderCurrency?: string;
  readonly requestedCurrency?: string;
  readonly error?: string;
}
export interface EditTicketDetailsOutcomeView {
  // saved | invalid_email | nothing_to_update | ticket_not_found | error
  readonly kind: string;
  /** When an order ref was submitted: whether it resolved to a real order. */
  readonly orderResolved?: boolean;
  /** The resolved order's display name (e.g. "#1001"), when it resolved. */
  readonly orderName?: string;
}

export interface EditShippingAddressOutcomeView {
  // saved | nothing_to_update | order_not_found | ticket_not_found |
  // update_failed | error
  readonly kind: string;
  /** Shopify's rejection detail on `update_failed` (log-grade, not UI copy). */
  readonly error?: string;
}

/** Shopify's `OrderCancelReason` values, as the cancel dialog offers them. */
export type CancelOrderReason =
  | "customer"
  | "declined"
  | "fraud"
  | "inventory"
  | "staff"
  | "other";

export interface CancelOrderOutcomeView {
  // cancelled | order_not_found | already_cancelled | ticket_not_found |
  // invalid_reason | cancel_failed | error
  readonly kind: string;
  readonly orderId?: string;
  /** Shopify's async cancellation job GID. */
  readonly jobId?: string | null;
  /** Shopify's rejection detail on `cancel_failed` (log-grade, not UI copy). */
  readonly error?: string;
}

// One restock/refund line the dashboard refund modal sends to the issue-refund
// endpoint. Mirrors the api's `RefundLineItemInput` (resolved client-side:
// restockType + locationId already decided from the order's fulfillment state +
// the operator's restock toggle).
export interface RefundLineItemPayload {
  readonly lineItemId: string;
  readonly quantity: number;
  readonly restockType: "RETURN" | "CANCEL" | "NO_RESTOCK";
  readonly locationId: string | null;
}

// Outcome of fetching the refund modal's context. `ok` carries the Shopify
// refund context (line items + pricing); the others tell the modal why it can't
// render (no order resolved, or Shopify wouldn't return the calculation).
export type RefundContextOutcome =
  | { readonly kind: "ok"; readonly context: ShopifyOrderRefundContext }
  | { readonly kind: "order_not_found" }
  | { readonly kind: "context_unavailable" }
  | { readonly kind: "ticket_not_found" }
  | { readonly kind: "error" };

export interface TicketShopifyPanels {
  readonly customer: ShopifyCustomer | null;
  readonly order: ShopifyOrder | null;
  readonly shopDomain: string | null;
}

// FulfillmentOperator portal — the minimal privacy projection the api returns (no customer
// PII). Mirrors the db's FulfillmentOperatorEscalation{ListItem,Detail} shapes; redefined
// here because the dashboard (Path B) imports only agent-core + contracts.
export interface FulfillmentOperatorEscalationListItemView {
  readonly id: string;
  readonly ticketId: string;
  readonly problem: string;
  readonly orderRef: string | null;
  readonly shipCity: string | null;
  readonly shipCountry: string | null;
  readonly trackingNumber: string | null;
  readonly status: string;
  readonly createdAt: string;
}
export interface FulfillmentOperatorEscalationAttachmentView {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
}

export interface FulfillmentOperatorEscalationDetailView
  extends FulfillmentOperatorEscalationListItemView {
  readonly note: string | null;
  readonly proposedResolution: string | null;
  /** Customer images forwarded with the support team's request. */
  readonly requestAttachments: ReadonlyArray<FulfillmentOperatorEscalationAttachmentView>;
  /** Files the fulfillment partner sent with their update. */
  readonly attachments: ReadonlyArray<FulfillmentOperatorEscalationAttachmentView>;
}

// ============================================================
// Typed endpoint methods. Reads take a Ctx (org); writes take org + decision
// UUID (DashboardContext satisfies both).
// ============================================================

export const api = {
  // ---- Reads ----
  today: (ctx: CallCtx): Promise<TodaySummary> =>
    okBody("/today", ctx) as Promise<TodaySummary>,

  tickets: (
    ctx: CallCtx,
    filter: TicketsFilter,
    page: number,
    limit: number,
  ): Promise<Page<TicketListRow>> => {
    const qs = new URLSearchParams();
    const trimmed = filter.q?.trim();
    if (trimmed) qs.set("q", trimmed);
    for (const v of filter.status ?? []) qs.append("status", v);
    for (const v of filter.excludeStatus ?? []) qs.append("excludeStatus", v);
    qs.set("page", String(page));
    qs.set("limit", String(limit));
    return okBody(`/tickets?${qs.toString()}`, ctx) as Promise<Page<TicketListRow>>;
  },

  ticketDetail: async (ctx: CallCtx, id: string): Promise<TicketDetail | null> => {
    const { status, body } = await call(`/tickets/${encodeURIComponent(id)}`, { ctx });
    if (status === 404) return null;
    if (status !== 200) throw new Error(`dashboard api ${status} on /tickets/:id`);
    return body as TicketDetail;
  },

  ticketConversationThread: async (
    ctx: CallCtx,
    id: string,
  ): Promise<TicketConversationThreadResult | null> => {
    const { status, body } = await call(
      `/tickets/${encodeURIComponent(id)}/conversation-thread`,
      { ctx },
    );
    if (status === 404) return null;
    if (status !== 200) {
      throw new Error(
        `dashboard api ${status} on /tickets/:id/conversation-thread`,
      );
    }
    return body as TicketConversationThreadResult;
  },

  ticketShopify: async (
    ctx: CallCtx,
    id: string,
  ): Promise<TicketShopifyPanels | null> => {
    const { status, body } = await call(
      `/tickets/${encodeURIComponent(id)}/shopify`,
      { ctx },
    );
    if (status === 404) return null;
    if (status !== 200) throw new Error(`dashboard api ${status} on /tickets/:id/shopify`);
    return body as TicketShopifyPanels;
  },

  // Fresh carrier tracking for the ticket-detail Tracking card. Best-effort: a
  // 17track / api hiccup must never break the ticket page, so any failure or
  // non-200 resolves to `unavailable` (the page then falls back to the on-ticket
  // tracking stamp). Returns the discriminated outcome.
  ticketTracking: async (
    ctx: CallCtx,
    id: string,
  ): Promise<TicketTrackingResult> => {
    try {
      const { status, body } = await call(
        `/tickets/${encodeURIComponent(id)}/tracking`,
        { ctx },
      );
      if (status === 404) return { kind: "not_found" };
      if (status !== 200 || !body) return { kind: "unavailable" };
      return body as TicketTrackingResult;
    } catch {
      return { kind: "unavailable" };
    }
  },

  ticketEvents: async (
    ctx: CallCtx,
    id: string,
    since: string,
  ): Promise<TicketEventsResult | null> => {
    const { status, body } = await call(
      `/tickets/${encodeURIComponent(id)}/events?since=${encodeURIComponent(since)}`,
      { ctx },
    );
    if (status === 404) return null;
    if (status !== 200) throw new Error(`dashboard api ${status} on /tickets/:id/events`);
    return body as TicketEventsResult;
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

  // Like `models`, but tolerant: returns null instead of redirecting/throwing
  // when the member can't read the catalog (403 — lacks settings.agents) or the
  // call otherwise fails. The ticket-page reply composer renders the model picker
  // only when this resolves, so a reply-only member still gets the composer
  // (minus the picker) rather than being bounced to /onboarding.
  replyModels: async (ctx: CallCtx): Promise<ModelsResponse | null> => {
    const { status, body } = await call("/models", { ctx, on403: "return" });
    return status === 200 ? (body as ModelsResponse) : null;
  },

  llmStatus: (ctx: CallCtx): Promise<LlmCredentialStatusResponse> =>
    okBody("/llm", ctx) as Promise<LlmCredentialStatusResponse>,

  settings: (ctx: CallCtx): Promise<TenantSettingsView> =>
    okBody("/settings", ctx) as Promise<TenantSettingsView>,

  resolutionPolicy: (ctx: CallCtx): Promise<ResolutionPolicyView> =>
    okBody("/resolution-policy", ctx) as Promise<ResolutionPolicyView>,

  // The @-reference catalog that drives the scenario-notes menu.
  factReferences: async (
    ctx: CallCtx,
  ): Promise<ReadonlyArray<FactReferenceEntryView>> =>
    (
      (await okBody("/fact-references", ctx)) as FactReferencesResponse
    ).entries,

  // Resolve @-references in a note against this tenant's facts and knowledge
  // docs, for the live warning. Mirrors the resolver the runtime uses.
  resolveFactReferences: async (
    ctx: CallCtx,
    text: string,
  ): Promise<ResolvedReferencesView> => {
    const { status, body } = await call("/fact-references/resolve", {
      method: "POST",
      body: { text },
      ctx,
    });
    if (status !== 200 || !body) {
      return { resolved: text, dangling: [] };
    }
    return body as ResolvedReferencesView;
  },

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

  // ---- Setup wizard ----
  onboardingState: (ctx: CallCtx): Promise<OnboardingStateView> =>
    okBody("/onboarding/state", ctx) as Promise<OnboardingStateView>,

  /** The connected store's own name/domain/currency — the brand-name prefill. */
  storeProfile: (ctx: CallCtx): Promise<StoreProfileView> =>
    okBody("/store-profile", ctx) as Promise<StoreProfileView>,

  /** The name the agent writes under. `null` clears it. */
  setBrandName: (ctx: CallCtx, brandName: string | null): Promise<CallResult> =>
    call("/brand", { method: "POST", body: { brandName }, ctx }),

  /**
   * Record a step outcome and/or move the resume pointer. The pointer-only form
   * (`{ nextStep }`) is written just before a connector OAuth redirect leaves
   * the SPA, so the round-trip lands back on the step the merchant left.
   */
  onboardingAdvance: (
    ctx: CallCtx,
    input: OnboardingAdvanceInput,
  ): Promise<CallResult> =>
    call("/onboarding/advance", { method: "POST", body: input, ctx }),

  /** "Set up later" — leave the wizard without finishing it. */
  onboardingDismiss: (ctx: CallCtx): Promise<CallResult> =>
    call("/onboarding/dismiss", { method: "POST", ctx }),

  onboardingComplete: (ctx: CallCtx): Promise<CallResult> =>
    call("/onboarding/complete", { method: "POST", ctx }),

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

  setCancellationRestock: (
    ctx: CallCtx,
    restock: boolean,
  ): Promise<CallResult> =>
    call("/cancellation-restock", { method: "POST", body: { restock }, ctx }),

  setShippingFacts: (
    ctx: CallCtx,
    input: {
      readonly processingTime: string;
      readonly deliveryTime: string;
      readonly shippingCost: string | null;
      readonly customsDuties: CustomsDutiesPayerView | null;
      readonly delayedAfterDays: number;
      readonly lostPackageInvestigationDays: number | null;
    },
  ): Promise<CallResult> =>
    call("/shipping-facts", { method: "POST", body: input, ctx }),

  setReturnsFacts: (
    ctx: CallCtx,
    input: {
      readonly returnWindowDays: number;
      readonly returnShippingPayer: ReturnShippingPayerView | null;
      readonly refundMethod: RefundMethodView | null;
      readonly refundProcessingTime: string | null;
    },
  ): Promise<CallResult> =>
    call("/returns-facts", { method: "POST", body: input, ctx }),

  setAddressUpdateAfterFulfillment: (
    ctx: CallCtx,
    enabled: boolean,
  ): Promise<CallResult> =>
    call("/address-update-after-fulfillment", {
      method: "POST",
      body: { enabled },
      ctx,
    }),

  setDiscountPolicy: (
    ctx: CallCtx,
    input: {
      readonly currencyCode: string;
      readonly askAbovePercentage: number;
      readonly maxPercentage: number;
      readonly askAboveFixedAmountMinorUnits: number;
      readonly maxFixedAmountMinorUnits: number;
      readonly maxValidityDays: number;
      readonly mode: DiscountPolicyMode;
    },
  ): Promise<CallResult> =>
    call("/discount-policy", { method: "POST", body: input, ctx }),

  setResolutionPolicy: (
    ctx: CallCtx,
    scenarios: ReadonlyArray<ResolutionScenarioView>,
  ): Promise<CallResult> =>
    call("/resolution-policy", { method: "POST", body: { scenarios }, ctx }),

  // Sender blocklist (settings/blocked-senders). The add value is classified
  // server-side: an address blocks one sender, a domain blocks the whole
  // domain including subdomains.
  blockedSenders: (ctx: CallCtx): Promise<BlockedSendersView> =>
    okBody("/blocked-senders", ctx) as Promise<BlockedSendersView>,

  addBlockedSender: (ctx: CallCtx, value: string): Promise<CallResult> =>
    call("/blocked-senders/add", { method: "POST", body: { value }, ctx }),

  removeBlockedSender: (
    ctx: CallCtx,
    entry: { readonly kind: "email" | "domain"; readonly value: string },
  ): Promise<CallResult> =>
    call("/blocked-senders/remove", { method: "POST", body: entry, ctx }),

  // Block THIS ticket's customer email (the ⋮ quick action). The api derives
  // the address from the ticket server-side; 409 = no customer email on it.
  blockTicketSender: (ctx: CallCtx, ticketId: string): Promise<CallResult> =>
    call(`/tickets/${encodeURIComponent(ticketId)}/block-sender`, {
      method: "POST",
      ctx,
    }),

  setFulfillmentOperatorSheet: (
    ctx: CallCtx,
    input: {
      readonly spreadsheetId: string;
      readonly range: string;
      readonly description: string | null;
    },
  ): Promise<CallResult> =>
    call("/fulfillment-operator-sheet", { method: "POST", body: input, ctx }),

  clearFulfillmentOperatorSheet: (ctx: CallCtx): Promise<CallResult> =>
    call("/fulfillment-operator-sheet/clear", { method: "POST", ctx }),

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

  // Decide a whole ticket's pending approval BUNDLE in one click (autonomous
  // loop). The api approves/rejects every pending row then publishes one event
  // so the runtime runs the bundle in order. `edits` carries manager-edited
  // tool inputs keyed by approval id (e.g. the edited reply), honored only on
  // approve.
  approveTicketBundle: async (
    ctx: CallCtx,
    ticketId: string,
    edits?: Record<string, unknown>,
  ): Promise<TicketBundleDecisionResultView> => {
    const { body } = await call(
      `/tickets/${encodeURIComponent(ticketId)}/approvals/approve`,
      {
        method: "POST",
        body: edits !== undefined ? { edits } : {},
        ctx,
      },
    );
    return (body as TicketBundleDecisionResultView | null) ?? { kind: "error" };
  },

  rejectTicketBundle: async (
    ctx: CallCtx,
    ticketId: string,
  ): Promise<TicketBundleDecisionResultView> => {
    const { body } = await call(
      `/tickets/${encodeURIComponent(ticketId)}/approvals/reject`,
      { method: "POST", ctx },
    );
    return (body as TicketBundleDecisionResultView | null) ?? { kind: "error" };
  },

  takeover: async (
    ctx: CallCtx,
    ticketId: string,
    reason?: string,
  ): Promise<TakeOverOutcomeView> => {
    const { body } = await call(`/tickets/${encodeURIComponent(ticketId)}/takeover`, {
      method: "POST",
      body: reason !== undefined ? { reason } : {},
      ctx,
    });
    return (body as TakeOverOutcomeView | null) ?? { kind: "error" };
  },

  resume: async (
    ctx: CallCtx,
    ticketId: string,
    reason?: string,
  ): Promise<ResumeOutcomeView> => {
    const { body } = await call(`/tickets/${encodeURIComponent(ticketId)}/resume`, {
      method: "POST",
      body: reason !== undefined ? { reason } : {},
      ctx,
    });
    return (body as ResumeOutcomeView | null) ?? { kind: "error" };
  },

  // Manually set a ticket's status (mark resolved, reopen, park waiting on the
  // customer …). The api validates the move against the ticket state machine and
  // returns the discriminated outcome (updated | unchanged | invalid_status |
  // transition_not_allowed | ticket_not_found).
  setStatus: async (
    ctx: CallCtx,
    ticketId: string,
    status: string,
    reason?: string,
  ): Promise<SetTicketStatusOutcomeView> => {
    const { body } = await call(`/tickets/${encodeURIComponent(ticketId)}/status`, {
      method: "POST",
      body: reason !== undefined ? { status, reason } : { status },
      ctx,
    });
    return (body as SetTicketStatusOutcomeView | null) ?? { kind: "error" };
  },

  // Resolve a ticket by hand — including one the manager has TAKEN OVER. Distinct
  // from `setStatus("resolved")`, which the state machine forbids directly from
  // human_takeover: this endpoint bridges the close legally for a human actor.
  // Returns the discriminated outcome (resolved | ticket_not_found).
  resolveTicket: async (
    ctx: CallCtx,
    ticketId: string,
    reason?: string,
  ): Promise<ResolveTicketOutcomeView> => {
    const { body } = await call(`/tickets/${encodeURIComponent(ticketId)}/resolve`, {
      method: "POST",
      body: reason !== undefined ? { reason } : {},
      ctx,
    });
    return (body as ResolveTicketOutcomeView | null) ?? { kind: "error" };
  },

  // Escalate a ticket to the workspace's fulfillmentOperator by hand. The problem statement
  // is what the fulfillment partner sees (portal + email); the ticket parks waiting on them.
  // Returns the discriminated outcome (escalated | already_escalated |
  // no_fulfillment_operator | transition_not_allowed | ticket_not_found).
  escalateFulfillmentOperator: async (
    ctx: CallCtx,
    ticketId: string,
    problem: string,
  ): Promise<EscalateFulfillmentOperatorOutcomeView> => {
    const { body } = await call(
      `/tickets/${encodeURIComponent(ticketId)}/escalate-fulfillment-operator`,
      { method: "POST", body: { problem }, ctx },
    );
    return (body as EscalateFulfillmentOperatorOutcomeView | null) ?? { kind: "error" };
  },

  // Issue an agent-recommended refund directly on a ticket. The agent only
  // *recommended* the refund (read-only), so there's no approval to approve;
  // this runs the equivalent of refund.create under the operator's authority
  // (gated on the refunds.issue permission). Returns the discriminated outcome
  // (issued | order_not_found | invalid_amount | already_refunded |
  // currency_mismatch | refund_failed | ticket_not_found).
  issueRefund: async (
    ctx: CallCtx,
    ticketId: string,
    amount: { readonly amount: string; readonly currencyCode: string },
    opts: {
      readonly reason?: string | null;
      readonly lineItems?: ReadonlyArray<RefundLineItemPayload>;
      readonly shipping?: {
        readonly amount: string;
        readonly currencyCode: string;
      } | null;
    } = {},
  ): Promise<IssueRefundOutcomeView> =>
    // A Shopify refusal (502) becomes `refund_failed`, so the operator is told
    // no money moved rather than shown a generic error.
    recover502("refund_failed", async () => {
      const { body } = await call(
        `/tickets/${encodeURIComponent(ticketId)}/refund`,
        {
          method: "POST",
          body: {
            amount,
            ...(opts.reason ? { reason: opts.reason } : {}),
            ...(opts.lineItems && opts.lineItems.length > 0
              ? { lineItems: opts.lineItems }
              : {}),
            ...(opts.shipping ? { shipping: opts.shipping } : {}),
          },
          ctx,
        },
      );
      return (body as IssueRefundOutcomeView | null) ?? { kind: "error" };
    }),

  // Hand-correct the customer / order the agent couldn't identify (the pencil on
  // the Customer / Order panels). Only non-empty fields are sent; an order ref is
  // resolved server-side to a real Shopify order when possible.
  editTicketDetails: async (
    ctx: CallCtx,
    ticketId: string,
    fields: {
      readonly customerEmail?: string;
      readonly customerName?: string;
      readonly customerPhone?: string;
      readonly orderRef?: string;
    },
  ): Promise<EditTicketDetailsOutcomeView> => {
    const { body } = await call(`/tickets/${encodeURIComponent(ticketId)}/details`, {
      method: "POST",
      body: fields,
      ctx,
    });
    return (body as EditTicketDetailsOutcomeView | null) ?? { kind: "error" };
  },

  // Fix the order's shipping address (the pencil on the Order card's Ship-to).
  // Only non-empty fields are sent; the api merges them over the order's
  // current address and writes the result to the real Shopify order.
  editShippingAddress: async (
    ctx: CallCtx,
    ticketId: string,
    fields: {
      readonly name?: string;
      readonly address1?: string;
      readonly address2?: string;
      readonly city?: string;
      readonly province?: string;
      readonly country?: string;
      readonly zip?: string;
      readonly phone?: string;
    },
  ): Promise<EditShippingAddressOutcomeView> => {
    const { body } = await call(
      `/tickets/${encodeURIComponent(ticketId)}/shipping-address`,
      { method: "POST", body: fields, ctx },
    );
    return (body as EditShippingAddressOutcomeView | null) ?? { kind: "error" };
  },

  // Cancel the ticket's order (the Cancel button on the Order card). Refunds
  // and restocks by default; Shopify processes both asynchronously. A real
  // store write that moves money — gated on `refunds.issue` server-side.
  cancelOrder: async (
    ctx: CallCtx,
    ticketId: string,
    input: {
      readonly refund: boolean;
      readonly restock: boolean;
      readonly reason: CancelOrderReason;
      readonly staffNote: string | null;
    },
  ): Promise<CancelOrderOutcomeView> =>
    // A Shopify refusal (502) becomes `cancel_failed`, so the operator is told
    // nothing was cancelled rather than shown a generic error.
    recover502("cancel_failed", async () => {
      const { body } = await call(
        `/tickets/${encodeURIComponent(ticketId)}/cancel-order`,
        { method: "POST", body: input, ctx },
      );
      return (body as CancelOrderOutcomeView | null) ?? { kind: "error" };
    }),

  // Refundable line items + pricing for the ticket's order, powering the
  // Shopify-style refund modal. Read-only (gated on `refunds.issue` like the
  // issue endpoint). Returns the discriminated outcome so the modal can explain
  // why it can't render (no order / Shopify wouldn't calculate).
  refundContext: async (
    ctx: CallCtx,
    ticketId: string,
  ): Promise<RefundContextOutcome> => {
    const { body } = await call(
      `/tickets/${encodeURIComponent(ticketId)}/refund-context`,
      { ctx },
    );
    return (body as RefundContextOutcome | null) ?? { kind: "error" };
  },

  // Resume + an immediate `ticket.resumed` tick — the agent retries now
  // instead of waiting for the customer's next reply. `fromTriage` does a FULL
  // retry: it rebinds the ticket to triage so the tick re-classifies + re-routes
  // (default re-runs the bound specialist's last step).
  retry: async (
    ctx: CallCtx,
    ticketId: string,
    opts: { readonly fromTriage?: boolean } = {},
  ): Promise<ResumeOutcomeView> => {
    const { body } = await call(`/tickets/${encodeURIComponent(ticketId)}/retry`, {
      method: "POST",
      ctx,
      ...(opts.fromTriage ? { body: { fromTriage: true } } : {}),
    });
    return (body as ResumeOutcomeView | null) ?? { kind: "error" };
  },

  // Re-send the SAME drafted reply whose delivery failed (NOT a re-run of the
  // agent): requeues the failed reply-delivery so the worker sweep sends it.
  retrySend: async (
    ctx: CallCtx,
    ticketId: string,
  ): Promise<{ readonly kind: string }> => {
    const { body } = await call(
      `/tickets/${encodeURIComponent(ticketId)}/retry-send`,
      { method: "POST", ctx },
    );
    return (body as { kind: string } | null) ?? { kind: "error" };
  },

  // Resend an approved reply that was never sent (skipped when the ticket was
  // taken over). Re-sends the EXACT approved draft; the ticket stays in
  // human_takeover. Returns the discriminated outcome (resent | nothing_to_resend
  // | not_in_takeover | send_failed | …).
  resendApproval: async (
    ctx: CallCtx,
    ticketId: string,
  ): Promise<{ readonly kind: string }> => {
    const { body } = await call(
      `/tickets/${encodeURIComponent(ticketId)}/resend-approval`,
      { method: "POST", ctx },
    );
    return (body as { kind: string } | null) ?? { kind: "error" };
  },

  // Send a human-drafted customer reply while driving a taken-over ticket. Goes
  // out on the same connector/thread the agent uses; the ticket stays in
  // human_takeover. Returns the discriminated outcome (sent | not_in_takeover |
  // no_thread | send_failed | …).
  sendReply: async (
    ctx: CallCtx,
    ticketId: string,
    bodyText: string,
    attachmentIds: ReadonlyArray<string> = [],
  ): Promise<{ readonly kind: string }> => {
    const { body } = await call(`/tickets/${encodeURIComponent(ticketId)}/reply`, {
      method: "POST",
      body:
        attachmentIds.length > 0 ? { bodyText, attachmentIds } : { bodyText },
      ctx,
    });
    return (body as { kind: string } | null) ?? { kind: "error" };
  },

  // Upload a file (raw bytes, the file's own content type) onto a ticket so it
  // can ride a reply. Returns the indexed attachment summary; the id is what
  // reply / approve requests reference. 400 bodies surface as a typed error
  // kind for the composer to explain.
  uploadTicketAttachment: async (
    ctx: CallCtx,
    ticketId: string,
    file: File,
  ): Promise<
    | { readonly kind: "uploaded"; readonly attachment: TicketAttachmentSummary }
    | { readonly kind: "rejected"; readonly error: string }
  > => {
    const doUpload = () =>
      fetch(
        `${apiBase()}/dashboard/tickets/${encodeURIComponent(ticketId)}/attachments?filename=${encodeURIComponent(file.name)}`,
        {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": file.type || "application/octet-stream",
            ...(ctx.workspaceId ? { "x-workspace-id": ctx.workspaceId } : {}),
          },
          body: file,
        },
      );
    let res = await doUpload();
    if (res.status === 401 && (await tryRefresh())) res = await doUpload();
    if (res.status === 401) throw new UnauthorizedError();
    if (res.status === 200) {
      const body = (await res.json()) as {
        attachment: TicketAttachmentSummary;
      };
      return { kind: "uploaded", attachment: body.attachment };
    }
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    return { kind: "rejected", error: body?.error ?? `status_${res.status}` };
  },

  // A short-lived signed URL for one attachment. The blob is fetched by the
  // browser straight from storage, so bytes never stream through the API.
  // Not cached — the URL expires in minutes.
  ticketAttachmentUrl: (
    ctx: CallCtx,
    ticketId: string,
    attachmentId: string,
  ): Promise<{
    readonly url: string;
    readonly expiresInSeconds: number;
    readonly filename: string;
    readonly contentType: string;
  }> =>
    okBody(
      `/tickets/${encodeURIComponent(ticketId)}/attachments/${encodeURIComponent(attachmentId)}/url`,
      ctx,
    ) as Promise<{
      readonly url: string;
      readonly expiresInSeconds: number;
      readonly filename: string;
      readonly contentType: string;
    }>,

  // The ticket's attachment index (uploads + fulfillment partner files) for the
  // composer's picker.
  ticketAttachments: async (
    ctx: CallCtx,
    ticketId: string,
  ): Promise<{ readonly attachments: ReadonlyArray<TicketAttachmentSummary> }> =>
    okBody(
      `/tickets/${encodeURIComponent(ticketId)}/attachments`,
      ctx,
    ) as Promise<{ readonly attachments: ReadonlyArray<TicketAttachmentSummary> }>,

  // Persist the workspace "Rephrase with AI" model (blank string clears it →
  // the rephrase handler falls back to its default). Gated on settings.agents.
  setRephraseModel: async (
    ctx: CallCtx,
    model: string,
  ): Promise<{ readonly ok: boolean }> => {
    const { body } = await call(`/settings/rephrase-model`, {
      method: "POST",
      body: { model },
      ctx,
    });
    return (body as { ok: boolean } | null) ?? { ok: false };
  },

  // AI-polish a reply draft. Returns the rewritten text on success, or a
  // discriminated reason (empty_input | no_llm | failed) the composer maps to a
  // friendly message. Spent against the tenant's own LLM credential.
  rephrase: async (
    ctx: CallCtx,
    text: string,
  ): Promise<{ readonly kind: string; readonly text?: string }> => {
    const { body } = await call(`/rephrase`, {
      method: "POST",
      body: { text },
      ctx,
    });
    return (body as { kind: string; text?: string } | null) ?? { kind: "error" };
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

  // ---- FulfillmentOperator portal ----
  fulfillmentOperatorTickets: async (
    ctx: CallCtx,
  ): Promise<ReadonlyArray<FulfillmentOperatorEscalationListItemView>> =>
    (
      (await okBody("/fulfillment-operator/tickets", ctx)) as {
        tickets: ReadonlyArray<FulfillmentOperatorEscalationListItemView>;
      }
    ).tickets,

  fulfillmentOperatorTicket: async (
    ctx: CallCtx,
    id: string,
  ): Promise<FulfillmentOperatorEscalationDetailView | null> => {
    const { status, body } = await call(
      `/fulfillment-operator/tickets/${encodeURIComponent(id)}`,
      { ctx },
    );
    if (status === 404) return null;
    if (status !== 200) {
      throw new Error(`dashboard api ${status} on /fulfillment-operator/tickets/:id`);
    }
    return body as FulfillmentOperatorEscalationDetailView;
  },

  fulfillmentOperatorAttachmentUrl: (
    ctx: CallCtx,
    escalationId: string,
    attachmentId: string,
  ): Promise<{
    readonly url: string;
    readonly expiresInSeconds: number;
    readonly filename: string;
    readonly contentType: string;
  }> =>
    okBody(
      `/fulfillment-operator/tickets/${encodeURIComponent(escalationId)}/attachments/${encodeURIComponent(attachmentId)}/url`,
      ctx,
    ) as Promise<{
      readonly url: string;
      readonly expiresInSeconds: number;
      readonly filename: string;
      readonly contentType: string;
    }>,

  fulfillmentOperatorUpdate: (
    ctx: CallCtx,
    id: string,
    input: {
      readonly note: string;
      readonly proposedResolution?: string | null;
      /** Ids from uploadFulfillmentOperatorAttachment, sent along with the update. */
      readonly attachmentIds?: ReadonlyArray<string>;
    },
  ): Promise<CallResult> =>
    call(`/fulfillment-operator/tickets/${encodeURIComponent(id)}/update`, {
      method: "POST",
      body: input,
      ctx,
      on403: "return",
    }),

  // Upload a file (raw bytes) for a fulfillment partner update — scoped to the fulfillment partner's
  // own open escalation. Mirrors uploadTicketAttachment.
  uploadFulfillmentOperatorAttachment: async (
    ctx: CallCtx,
    escalationId: string,
    file: File,
  ): Promise<
    | { readonly kind: "uploaded"; readonly attachment: TicketAttachmentSummary }
    | { readonly kind: "rejected"; readonly error: string }
  > => {
    const doUpload = () =>
      fetch(
        `${apiBase()}/dashboard/fulfillment-operator/tickets/${encodeURIComponent(escalationId)}/attachments?filename=${encodeURIComponent(file.name)}`,
        {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": file.type || "application/octet-stream",
            ...(ctx.workspaceId ? { "x-workspace-id": ctx.workspaceId } : {}),
          },
          body: file,
        },
      );
    let res = await doUpload();
    if (res.status === 401 && (await tryRefresh())) res = await doUpload();
    if (res.status === 401) throw new UnauthorizedError();
    if (res.status === 200) {
      const body = (await res.json()) as {
        attachment: TicketAttachmentSummary;
      };
      return { kind: "uploaded", attachment: body.attachment };
    }
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    return { kind: "rejected", error: body?.error ?? `status_${res.status}` };
  },

  fulfillmentOperatorUpdateTracking: (
    ctx: CallCtx,
    id: string,
    input: {
      readonly trackingNumber: string;
      readonly trackingCompany?: string | null;
    },
  ): Promise<CallResult> =>
    call(`/fulfillment-operator/tickets/${encodeURIComponent(id)}/tracking`, {
      method: "POST",
      body: input,
      ctx,
      on403: "return",
    }),

  inviteFulfillmentOperator: (
    ctx: CallCtx,
    input: {
      readonly email: string;
      readonly name?: string;
      readonly workosInvitationId?: string;
    },
  ): Promise<CallResult> =>
    call("/fulfillment-operator/invite", { method: "POST", body: input, ctx }),
};
