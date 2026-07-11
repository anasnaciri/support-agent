// Shared dashboard ↔ api JSON contract (Path B).
//
// The dashboard hosts on Cloudflare Workers as a pure api client; it can't
// open a Postgres pool or run the Effect service stack, so it can't import
// `@support-agent/db` / `services` / `providers`. These types are the single
// source of truth for the JSON shapes `apps/api`'s `/dashboard/*` endpoints
// return and accept. The api's `dashboard-reads` queries are typed by them,
// and (in the cutover slice) the dashboard's typed api-client imports them.
//
// This package has NO runtime dependencies beyond `@support-agent/agent-core`
// (pure types + helpers, no `node:` imports), so it is Worker-safe. Keep it
// that way — do not import drizzle, effect runtime, or node built-ins here.

import type {
  AgentMode,
  Permission,
  ProviderName,
  ToolRisk,
  ToolSideEffectClass,
  ToolConnectorScopeRequirement,
  TenantToolControl,
} from "@support-agent/agent-core";
import type { RbacPermissionId } from "./rbac-permissions.js";

// ============================================================
// Pagination (canonical). The dashboard imports these in the cutover slice
// instead of re-deriving them.
// ============================================================

export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;

export const parsePageSize = (value: string | undefined): number => {
  const parsed = Number(value);
  return PAGE_SIZE_OPTIONS.some((option) => option === parsed)
    ? parsed
    : DEFAULT_PAGE_SIZE;
};

export const parsePageNumber = (value: string | undefined): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
};

export const totalPagesFor = (totalRows: number, pageSize: number): number =>
  Math.max(1, Math.ceil(totalRows / pageSize));

export const clampPage = (
  page: number,
  totalRows: number,
  pageSize: number,
): number => Math.min(page, totalPagesFor(totalRows, pageSize));

export interface Page<Row> {
  readonly totalRows: number;
  readonly page: number;
  readonly pageSize: number;
  readonly rows: ReadonlyArray<Row>;
}

// ============================================================
// Today view
// ============================================================

export interface TodayPendingApproval {
  readonly id: string;
  readonly ticketId: string;
  readonly tool: string;
  readonly agentId: string;
  readonly riskLevel: string;
  readonly createdAt: string;
}

export interface TodayTakeoverTicket {
  readonly id: string;
  readonly subject: string | null;
  readonly category: string | null;
  readonly updatedAt: string;
}

export interface TodaySummary {
  /** Ticket count per status (raw; the view derives groupings like "in progress"). */
  readonly statusCounts: Record<string, number>;
  readonly resolvedTodayCount: number;
  readonly pendingApprovals: ReadonlyArray<TodayPendingApproval>;
  readonly takeoverTickets: ReadonlyArray<TodayTakeoverTicket>;
}

// ============================================================
// Tickets
// ============================================================

/**
 * The two wait facts a ticket can hold AT ONCE (concurrent wait states). A ticket's
 * `status` is the single "who acts next" pointer (`primaryWaitStatus` —
 * approval wins), but a ticket parked `waiting_for_approval` can ALSO carry an
 * open supplier escalation. Both facts are row-derived (pending `approvals`
 * rows / open `ticket_supplier_escalations` rows) and surfaced here so the
 * dashboard can render a second "waiting on supplier" chip without re-deriving
 * anything. Optional on the wire: an older api that doesn't send it just omits
 * the extra chip.
 */
export interface TicketWaitingOn {
  readonly approval: boolean;
  readonly supplier: boolean;
}

export interface TicketListRow {
  readonly id: string;
  readonly subject: string | null;
  readonly status: string;
  readonly category: string | null;
  readonly currentAgentId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Derived concurrent wait facts (approval + supplier); see {@link TicketWaitingOn}. */
  readonly waitingOn?: TicketWaitingOn;
  // Row-display enrichments (all same-row on `tickets`, no joins). Optional so a
  // dashboard built against a newer contract still renders against an older api
  // that doesn't send them yet.
  /** Requester email (from the ticket context) — powers the row avatar + name. */
  readonly customerEmail?: string | null;
  /** Whatever order identifier was stamped on the ticket (name like "#1001",
   *  or a GID/numeric id); formatted for display in the row. */
  readonly orderRef?: string | null;
  /** Ticket priority ("normal" | "high" | …); drives the PRIORITY tag. */
  readonly priority?: string | null;
  /** The agent's short ticket summary, used as the row's preview snippet. */
  readonly preview?: string | null;
}

export interface TicketsFilter {
  /**
   * Free-text query matched (case-insensitive substring) against a ticket's
   * subject, summary, and category. Empty/absent means no filter.
   */
  readonly q?: string | undefined;
  /**
   * Restrict to these statuses (the tickets-list status picker). Empty/absent
   * means every status.
   */
  readonly status?: ReadonlyArray<string> | undefined;
  /**
   * Hide these statuses (the ticket sidebar's "Needs attention" mode passes
   * `["resolved"]`). Empty/absent means hide nothing.
   */
  readonly excludeStatus?: ReadonlyArray<string> | undefined;
}

export interface TicketDetailTicket {
  readonly id: string;
  readonly subject: string | null;
  readonly status: string;
  readonly category: string | null;
  readonly currentAgentId: string;
  readonly priority: string;
  readonly summary: string | null;
  readonly context: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resolvedAt: string | null;
  /**
   * The statuses a human may set BY HAND from here, matrix-validated server-side
   * (agent-core `allowedManualStatusTargets`). The ticket page renders exactly
   * these as the ⋮ "change status" options so the SPA never has to re-derive the
   * §10 transition matrix. Empty when nothing is hand-settable from the current
   * status.
   */
  readonly manualStatusTargets: ReadonlyArray<string>;
  /** Derived concurrent wait facts (approval + supplier); see {@link TicketWaitingOn}. */
  readonly waitingOn?: TicketWaitingOn;
}

export interface AuditEntry {
  readonly id: string;
  readonly ticketId: string | null;
  readonly action: string;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly occurredAt: string;
  readonly details: unknown;
}

export interface ApprovalDetail {
  readonly id: string;
  readonly ticketId: string;
  readonly agentId: string;
  readonly tool: string;
  readonly proposedInput: unknown;
  readonly approvedInput: unknown;
  readonly reasoning: string | null;
  readonly riskLevel: string;
  readonly status: string;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly decisionReason: string | null;
  readonly expiresAt: string;
  readonly createdAt: string;
}

export interface TicketDetailReplyDelivery {
  readonly id: string;
  readonly ticketId: string;
  readonly status: string;
  readonly tool: string;
  readonly mailbox: string | null;
  readonly draftId: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly lastError: string | null;
  readonly nextAttemptAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * An approved customer reply that was never sent (the ticket was taken over
 * before the approval's delivery ran, so the runtime skipped it). Surfaced so
 * an operator can one-click resend it. `null` when there is nothing to resend.
 */
export interface TicketDetailApprovedNotSent {
  readonly approvalId: string;
  readonly bodyPreview: string;
  readonly occurredAt: string;
}

export interface TicketDetail {
  readonly ticket: TicketDetailTicket;
  readonly auditEntries: ReadonlyArray<AuditEntry>;
  readonly approvals: ReadonlyArray<ApprovalDetail>;
  readonly activeReplyDelivery: TicketDetailReplyDelivery | null;
  readonly approvedNotSent: TicketDetailApprovedNotSent | null;
}

export interface DashboardConversationParticipant {
  readonly name: string | null;
  readonly email: string;
}

export interface DashboardConversationAttachment {
  /**
   * The `ticket_attachments` row id, when the file is indexed on the ticket —
   * exchange it at `/dashboard/tickets/:id/attachments/:attachmentId/url` for
   * a short-lived signed URL to preview or download it. `null` for an
   * attachment a connector reported but we never stored bytes for; those show
   * as an inert badge.
   */
  readonly id: string | null;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
}

/**
 * An attachment indexed on a ticket (uploaded by a teammate or supplier, or
 * ingested from an inbound customer message). `id` is the only handle
 * clients ever pass back — storage keys stay server-side.
 */
export interface TicketAttachmentSummary {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly source: "inbound" | "supplier" | "merchant";
  readonly createdAt: string;
}

export interface TicketAttachmentUploadResponse {
  readonly attachment: TicketAttachmentSummary;
}

export interface DashboardConversationMessage {
  readonly id: string;
  readonly direction: "inbound" | "outbound";
  readonly from: DashboardConversationParticipant;
  readonly to: ReadonlyArray<DashboardConversationParticipant>;
  readonly subject: string | null;
  readonly bodyText: string;
  readonly sanitizedBodyHtml: string | null;
  readonly sentAt: string;
  readonly attachments: ReadonlyArray<DashboardConversationAttachment>;
}

export interface DashboardConversationThread {
  readonly subject: string;
  readonly participants: ReadonlyArray<DashboardConversationParticipant>;
  readonly messages: ReadonlyArray<DashboardConversationMessage>;
}

export type TicketConversationThreadUnavailableReason =
  | "no_thread"
  | "thread_not_found"
  | "auth_required"
  | "mailbox_ambiguous"
  | "provider_unavailable";

export type TicketConversationThreadResult =
  | {
      readonly status: "available";
      readonly thread: DashboardConversationThread;
    }
  | {
      readonly status: "unavailable";
      readonly reason: TicketConversationThreadUnavailableReason;
    };

// ============================================================
// Live tracking (ticketTracking endpoint → 17track)
// ============================================================

export type DashboardTrackingStatus =
  | "in_transit"
  | "delivered"
  | "exception"
  | "pending"
  | "unknown";

export interface DashboardTrackingScan {
  readonly occurredAt: string;
  readonly location: string | null;
  readonly description: string;
}

/** A live carrier lookup, serialized for the dashboard (Dates → ISO strings). */
export interface DashboardTracking {
  readonly kind: "live" | "no_provider";
  readonly trackingNumber: string;
  readonly carrier: string | null;
  readonly status: DashboardTrackingStatus | null;
  readonly lastScan: DashboardTrackingScan | null;
  readonly estimatedDeliveryAt: string | null;
  readonly trackingUrl: string;
  readonly originCountry: string | null;
  readonly destinationCountry: string | null;
  readonly transitDays: number | null;
  readonly checkpoints: ReadonlyArray<DashboardTrackingScan>;
  readonly reason: "no_api_key" | "unsupported_carrier" | "sync_pending" | null;
}

export type TicketTrackingResult =
  | { readonly kind: "ok"; readonly tracking: DashboardTracking }
  | { readonly kind: "no_tracking_number" }
  | { readonly kind: "not_found" }
  | { readonly kind: "unavailable" };

export interface TicketEventsResult {
  readonly events: ReadonlyArray<{
    readonly id: string;
    readonly action: string;
    readonly actorType: string;
    readonly actorId: string | null;
    readonly occurredAt: string;
  }>;
}

// ============================================================
// Approvals
// ============================================================

export interface ApprovalsFilter {
  /**
   * Status values to include; absent/empty defaults to `["pending"]`. All four
   * filters narrow by membership — OR within a field, AND across fields.
   */
  readonly status?: ReadonlyArray<string> | undefined;
  readonly risk?: ReadonlyArray<string> | undefined;
  readonly tool?: ReadonlyArray<string> | undefined;
  readonly agent?: ReadonlyArray<string> | undefined;
}

export interface ApprovalListRow {
  readonly id: string;
  readonly ticketId: string;
  readonly agentId: string;
  readonly tool: string;
  readonly status: string;
  readonly riskLevel: string;
  readonly createdAt: string;
  readonly decidedAt: string | null;
}

export interface ApprovalsListResult extends Page<ApprovalListRow> {
  /** Counts per status across the tenant (unfiltered) for the header chips. */
  readonly statusCounts: Record<string, number>;
  readonly toolFacets: ReadonlyArray<string>;
  readonly agentFacets: ReadonlyArray<string>;
}

// ============================================================
// Audit log
// ============================================================

export interface AuditFilter {
  /** Action prefix (LIKE `${action}%`), matching the dashboard's filters. */
  readonly action?: string | undefined;
  /** actorType exact match. */
  readonly actor?: string | undefined;
}

// ============================================================
// Connector connections (integrations pages + ticket-detail shop domain)
// ============================================================

export interface ConnectorConnectionView {
  readonly id: string;
  readonly provider: string;
  readonly shopDomain: string | null;
  readonly status: string;
  readonly scopes: ReadonlyArray<string>;
  /** Connector-specific metadata (e.g. LLM rows carry `baseURL`). */
  readonly metadata: unknown;
  readonly installedAt: string | null;
  readonly revokedAt: string | null;
  readonly updatedAt: string | null;
}

/**
 * Whether the tenant can start a Shopify connect. `available` mirrors the
 * api's authoritative install gate (same resolver the install + grant-mint
 * endpoints run): false when a pilot workspace has no provisioned custom app
 * (or it was revoked), and false when a SaaS deployment ships no global app.
 * The Connect button renders disabled whenever `available` is false —
 * `requiresProvisioning` / `provisioned` / `status` only pick the
 * explanation copy.
 */
export interface ShopifyAppGateView {
  readonly requiresProvisioning: boolean;
  readonly provisioned: boolean;
  readonly status: "ready" | "connected" | "revoked" | null;
  readonly available: boolean;
}

// ============================================================
// Admin (platform operator) — apps/admin
// ============================================================

export type ShopifyAppStatus = "ready" | "connected" | "revoked";

export interface AdminOpenRouterCredentialView {
  readonly status: "active" | "revoked";
  readonly installedAt: string;
  readonly updatedAt: string;
}

/** One row in the admin tenant list. */
export interface AdminTenantSummary {
  readonly id: string;
  readonly name: string;
  readonly workosOrganizationId: string | null;
  /**
   * The WorkOS organization's display name, resolved from WorkOS at request
   * time. `null` when there's no org, WorkOS isn't configured, or the lookup
   * failed — the admin UI then shows just the id.
   */
  readonly workosOrganizationName: string | null;
  readonly createdAt: string;
  /** Pilot Shopify custom-app provisioning at a glance. */
  readonly shopifyApp: {
    readonly provisioned: boolean;
    readonly status: ShopifyAppStatus | null;
  };
  readonly connectionCount: number;
}

/** Operator view of one tenant. Never includes any secret. */
export interface AdminTenantDetail {
  readonly tenant: {
    readonly id: string;
    readonly name: string;
    readonly workosOrganizationId: string | null;
    /** The WorkOS org's display name (resolved from WorkOS); null when absent. */
    readonly workosOrganizationName: string | null;
    readonly shopifyDomain: string | null;
    readonly createdAt: string;
  };
  readonly shopifyApp: {
    readonly clientId: string;
    readonly shopDomain: string | null;
    /** Operator-pasted store-unique install link (pilot), or null. */
    readonly installLink: string | null;
    readonly status: ShopifyAppStatus;
    readonly updatedAt: string;
  } | null;
  readonly connections: ReadonlyArray<ConnectorConnectionView>;
  readonly llm: {
    readonly effectiveProvider: string | null;
    readonly effectiveSource: "workspace" | "account" | null;
    readonly workspaceOverride: {
      readonly provider: string;
      readonly status: "active" | "revoked";
      readonly updatedAt: string | null;
    } | null;
    readonly accountOpenrouter: AdminOpenRouterCredentialView | null;
  };
}

export interface AdminAccountDetail {
  readonly organizationId: string;
  /**
   * The WorkOS organization's display name, resolved from WorkOS at request
   * time. `null` when WorkOS isn't configured or the lookup failed.
   */
  readonly organizationName: string | null;
  readonly workspaces: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly createdAt: string;
  }>;
  readonly openrouter: AdminOpenRouterCredentialView | null;
}

// ============================================================
// Per-agent overrides (settings/agents) — model + system prompt
// ============================================================

export interface AgentOverrideRow {
  readonly agentId: string;
  readonly model: string | null;
  // Tenant-authored text appended to the agent's built-in prompt (null → none).
  readonly systemPrompt: string | null;
  // Per-tool "ask first" vs "auto" choices for this agent, keyed by tool name
  // (null/absent → the tool's agent default applies). Only `permission-toggle`
  // tools ever appear here; the runtime overlays this onto the agent's
  // permissionOverrides.
  readonly toolPermissions: Readonly<Record<string, Permission>> | null;
}

// ============================================================
// Knowledge base (settings/knowledge) — tenant policy / reference documents
// the support agents consult via the knowledge.search tool. Dates are ISO
// strings so the type stays Worker-safe.
// ============================================================

export type KnowledgeSourceType = "text" | "url";

export interface KnowledgeDocumentSummaryView {
  readonly id: string;
  readonly title: string;
  readonly sourceType: KnowledgeSourceType;
  // The fetched page for a `url` doc; null for a pasted `text` doc.
  readonly sourceUrl: string | null;
  // Last successful snapshot time for a `url` doc; null for `text`.
  readonly fetchedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface KnowledgeDocumentView extends KnowledgeDocumentSummaryView {
  // The full readable text (pasted verbatim, or extracted from the URL).
  readonly content: string;
}

// ============================================================
// LLM usage (settings/usage)
// ============================================================

export interface UsageDecisionRow {
  readonly occurredAt: string;
  readonly details: unknown;
}

// ============================================================
// Catalog (agents + tools inventory) — GET /dashboard/catalog
// ============================================================
//
// The dashboard can't keep `@support-agent/agents`/`tools` in its Worker
// bundle (they transitively import `services`, which uses node built-ins), so
// the static agent/tool inventory is projected to plain JSON by the api.

export interface ToolDto {
  readonly name: string;
  readonly description: string;
  readonly risk: ToolRisk;
  readonly defaultPermission: Permission;
  readonly sideEffectClass: ToolSideEffectClass;
  readonly requiredConnectorScopes?: ToolConnectorScopeRequirement;
  // Tenant-facing metadata. Present only on tools a merchant can configure; the
  // dashboard renders its "Actions" card from tools that carry a `tenantControl`.
  readonly displayName?: string;
  readonly displayDescription?: string;
  readonly tenantControl?: TenantToolControl;
}

export interface AgentDto {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly mode: AgentMode;
  readonly provider: ProviderName;
  readonly model: string;
  readonly fallback?: { readonly provider: ProviderName; readonly model: string };
  readonly promptTemplate: string;
  readonly tools: ReadonlyArray<string>;
  readonly permissionOverrides: Readonly<Record<string, Permission>>;
  readonly handoffs: ReadonlyArray<string>;
  readonly maxTurnsPerTick: number;
  readonly temperature?: number;
  // True for merchant-authored custom agents; false for built-ins. The list
  // page badges + routes custom rows to the editable form.
  readonly isCustom: boolean;
  // Custom-agent inbound routing (Phase C): the one-liner the handoff roster
  // shows, and the agent ids this agent opts to be callable from.
  readonly whenToUse?: string | null;
  readonly callableFrom?: ReadonlyArray<string>;
}

export interface CatalogResponse {
  readonly agents: ReadonlyArray<AgentDto>;
  readonly tools: ReadonlyArray<ToolDto>;
}

// ============================================================
// Custom (merchant-authored) agents — /dashboard/custom-agents
// ============================================================

export type CustomAgentStatus = "draft" | "active" | "disabled";

// The editable shape returned by GET /dashboard/custom-agents/:id. Carries the
// RAW `instructions` (not the scaffold-composed prompt) so the edit form can
// prefill exactly what the merchant typed. Dates are ISO strings (Worker-safe).
export interface CustomAgentView {
  readonly agentId: string;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly model: string;
  readonly tools: ReadonlyArray<string>;
  readonly handoffs: ReadonlyArray<string>;
  readonly callableFrom: ReadonlyArray<string>;
  readonly permissionOverrides: Readonly<Record<string, Permission>>;
  readonly whenToUse: string | null;
  readonly maxTurnsPerTick: number;
  readonly status: CustomAgentStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// The body the dashboard POSTs/PUTs to create or update a custom agent. The
// server assigns the id (create) and validates tools/handoffs/scopes.
export interface CustomAgentWriteBody {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly model: string;
  readonly tools: ReadonlyArray<string>;
  readonly handoffs: ReadonlyArray<string>;
  readonly callableFrom: ReadonlyArray<string>;
  readonly permissionOverrides: Readonly<Record<string, Permission>>;
  readonly whenToUse: string | null;
  readonly maxTurnsPerTick: number;
  readonly status: CustomAgentStatus;
}

// Stable validation/error codes the api returns (HTTP 4xx) and the dashboard
// maps to friendly copy. Unknown codes fall back to a generic message.
export type CustomAgentErrorCode =
  | "name_required"
  | "name_too_long"
  | "description_required"
  | "description_too_long"
  | "instructions_required"
  | "instructions_too_long"
  | "model_required"
  | "invalid_tool"
  | "invalid_handoff"
  | "self_handoff"
  | "invalid_callable_from"
  | "missing_connector_scope"
  | "invalid_permission"
  | "invalid_status"
  | "duplicate_name"
  | "not_found";

// ============================================================
// Model catalog (settings/agents picker) — GET /dashboard/models
// ============================================================
//
// The api resolves the tenant's active LLM credential server-side and fetches
// the provider's model list, so the decrypted key never reaches the browser.

export interface ModelOption {
  readonly id: string;
  readonly name: string;
  /** Short family label used to group models in the picker (e.g. "Claude"). */
  readonly family: string;
  readonly contextLength?: number;
}

export interface ModelsResponse {
  /** Whether the tenant has an active LLM credential at all. */
  readonly connected: boolean;
  readonly provider: string | null;
  readonly entries: ReadonlyArray<ModelOption>;
  /** Set when the upstream provider call failed; entries falls back to []. */
  readonly error: string | null;
  /**
   * The model currently configured for the "Rephrase with AI" action, or null
   * when the tenant hasn't picked one (the rephrase handler then uses a
   * built-in default). Lets the composer's model dropdown show the current
   * selection alongside the catalog in a single fetch.
   */
  readonly rephraseModel?: string | null;
}

export interface LlmCredentialStatusResponse {
  readonly effective: {
    readonly provider: string;
    readonly source: "workspace" | "account";
  } | null;
  readonly workspaceOverride: {
    readonly provider: string;
    readonly status: "active" | "revoked";
    readonly updatedAt: string | null;
  } | null;
  readonly accountDefault: {
    readonly provider: "openrouter";
    readonly status: "active" | "revoked";
    readonly updatedAt: string;
  } | null;
}

// ============================================================
// Tenant / onboarding — GET /dashboard/tenant, POST /dashboard/onboarding
// ============================================================

export interface TenantInfo {
  readonly tenantId: string;
  readonly name: string;
}

export interface TenantResponse {
  /** null when the WorkOS org has no tenant yet (dashboard → /onboarding). */
  readonly tenant: TenantInfo | null;
}

export interface OnboardingResult {
  readonly tenantId: string;
  /** true when the org already had a tenant (idempotent re-submit). */
  readonly alreadyExisted: boolean;
}

// ============================================================
// Workspaces — GET/POST /dashboard/workspaces (+ :id/rename, :id/delete)
// ============================================================
//
// One WorkOS org owns many workspaces (tenant rows); each has its own store,
// mailboxes, LLM credential, tickets, knowledge, and settings. Requests pin a
// workspace via the `x-workspace-id` header; without it the api uses the
// DEFAULT workspace (oldest row — `workspaces[0]`).

export interface WorkspaceSummary {
  readonly id: string;
  readonly name: string;
  /** ISO timestamp. */
  readonly createdAt: string;
  /** Connected Shopify shop, or null — the switcher's at-a-glance hint. */
  readonly shopifyDomain: string | null;
}

export interface WorkspacesResponse {
  /** Default first; empty → the org needs onboarding. */
  readonly workspaces: ReadonlyArray<WorkspaceSummary>;
  readonly defaultWorkspaceId: string | null;
}

// The workspace switcher spans BOTH roles: one person can be a MERCHANT in one
// workspace and a SUPPLIER in another (org-independent binding). Each entry is
// tagged so the switcher routes to the right surface and the session loads the
// right permissions. Merchant entries come from the org-scoped list; supplier
// entries from the binding-anchored list (cross-org). Shared by both dashboards.

export type WorkspaceKind = "merchant" | "supplier";

export interface UnifiedWorkspace extends WorkspaceSummary {
  readonly kind: WorkspaceKind;
}

/**
 * Merge the merchant + supplier workspace lists into one switcher list. Merchant
 * entries are included only when the user actually has merchant access
 * (`includeMerchant` — else the org-scoped list would over-list workspaces to a
 * pure supplier who merely belongs to the merchant's WorkOS org). A workspace in
 * both lists is a merchant entry (merchant wins). Order: merchant first (already
 * default-ordered), then supplier-only workspaces.
 */
export const mergeWorkspaces = (
  merchant: ReadonlyArray<WorkspaceSummary>,
  supplier: ReadonlyArray<WorkspaceSummary>,
  includeMerchant: boolean,
): ReadonlyArray<UnifiedWorkspace> => {
  const out: UnifiedWorkspace[] = [];
  const seen = new Set<string>();
  if (includeMerchant) {
    for (const w of merchant) {
      out.push({ ...w, kind: "merchant" });
      seen.add(w.id);
    }
  }
  for (const w of supplier) {
    if (seen.has(w.id)) continue;
    out.push({ ...w, kind: "supplier" });
  }
  return out;
};

/** Where selecting a workspace of this kind lands the user. */
export const surfaceHomeForKind = (kind: WorkspaceKind): string =>
  kind === "supplier" ? "/supplier/tickets" : "/";

export interface CreateWorkspaceResult {
  readonly workspaceId: string;
}

// ============================================================
// Tenant settings — GET /dashboard/settings
// ============================================================
//
// Resolved view of `tenants.settings` (defaults already applied by the api),
// backing the refund-policy + supplier-escalation (Google Sheets) pages.

export type RefundPolicyMode = "thresholds" | "always_ask" | "always_deny";

export interface RefundPolicyView {
  readonly askAboveMinorUnits: number;
  readonly denyAboveMinorUnits: number;
  readonly currencyCode: string;
  /**
   * How the policy behaves: amount `thresholds`, `always_ask` (every refund
   * waits for approval), or `always_deny` (every refund blocked).
   */
  readonly mode: RefundPolicyMode;
}

export type DiscountPolicyMode = "thresholds" | "always_ask" | "always_deny";

export interface DiscountPolicyView {
  readonly askAbovePercentage: number;
  readonly maxPercentage: number;
  readonly askAboveFixedAmountMinorUnits: number;
  readonly maxFixedAmountMinorUnits: number;
  readonly currencyCode: string;
  readonly maxValidityDays: number;
  /**
   * How the policy behaves: percentage/amount `thresholds`, `always_ask`
   * (every coupon waits for approval), or `always_deny` (the agent never
   * issues a coupon).
   */
  readonly mode: DiscountPolicyMode;
}

export interface SupplierEscalationSheetView {
  readonly spreadsheetId: string;
  readonly range: string;
  readonly description: string | null;
}

export interface LegalAcceptanceView {
  readonly dataProcessingNoticeVersion: string;
  readonly dpaVersion: string;
  readonly acceptedAt: string;
  readonly acceptedByUserId: string | null;
}

/**
 * Sender blocklist for the `/settings/blocked-senders` page. Served by its
 * own permission-gated GET (NOT part of `TenantSettingsView`, whose endpoint
 * is reachable by any signed-in member). Email entries block one address;
 * domain entries block the domain and all its subdomains.
 */
export interface BlockedSendersView {
  readonly emails: ReadonlyArray<string>;
  readonly domains: ReadonlyArray<string>;
}

/** Who settles customs / import duties on an international order. */
export type CustomsDutiesPayerView = "customer" | "merchant" | "not_applicable";

/**
 * The store's structured shipping facts, edited on the Knowledge base page.
 * `null` when the merchant hasn't filled the form — agents then fall back to
 * searching the knowledge documents for a delivery window.
 *
 * `deliveryTime` and `delayedAfterDays` are the two the agents act on: the
 * former is the window lateness is measured against, the latter the exact point
 * past which a shipment earns a supplier check.
 */
export interface ShippingFactsView {
  readonly processingTime: string;
  readonly deliveryTime: string;
  readonly shippingCost: string | null;
  readonly customsDuties: CustomsDutiesPayerView | null;
  readonly delayedAfterDays: number;
  /**
   * Whole days in transit past which the store stops waiting on a missing
   * package and makes the customer whole (refund / reship) — a later point on
   * the same timeline than `delayedAfterDays`. `null` when the merchant hasn't
   * stated one.
   */
  readonly lostPackageInvestigationDays: number | null;
}

/** Who pays return shipping — mirror of the services `ReturnShippingPayer`. */
export type ReturnShippingPayerView = "customer" | "merchant" | "depends";

/** How a refund is issued — mirror of the services `RefundMethod`. */
export type RefundMethodView = "original" | "store_credit" | "customer_choice";

/**
 * The store's structured returns/refund facts. `null` until the merchant
 * configures one. Only `returnWindowDays` is required; the rest are `null`
 * until stated.
 */
export interface ReturnsFactsView {
  readonly returnWindowDays: number;
  readonly returnShippingPayer: ReturnShippingPayerView | null;
  readonly refundMethod: RefundMethodView | null;
  readonly refundProcessingTime: string | null;
}

export interface TenantSettingsView {
  readonly notificationEmail: string | null;
  readonly refundPolicy: RefundPolicyView;
  readonly discountPolicy: DiscountPolicyView;
  readonly supplierEscalationSheet: SupplierEscalationSheetView | null;
  readonly legalAcceptance: LegalAcceptanceView | null;
  /**
   * Whether `order.cancel` returns the cancelled order's items to inventory.
   * Backs the refund-policy page's "Order cancellations" restock checkbox.
   * Defaults-on-read to true.
   */
  readonly cancellationRestock: boolean;
  /** The store's shipping facts; `null` until the merchant configures one. */
  readonly shippingFacts: ShippingFactsView | null;
  /** The store's returns facts; `null` until the merchant configures one. */
  readonly returnsFacts: ReturnsFactsView | null;
}

// ============================================================
// Resolution policy (scenario agent)
// ============================================================

export type ScenarioActionPermissionView = "allow" | "ask";

export interface ScenarioActionView {
  /** Tool id (e.g. "refund.create"); the UI renders a plain-language label. */
  readonly tool: string;
  readonly permission: ScenarioActionPermissionView;
}

export type SupplierModeView =
  | "escalate_and_wait"
  | "notify_and_proceed"
  | "none";

export interface ResolutionScenarioView {
  readonly key: string;
  readonly label: string;
  /** "When does this apply" — shown for custom scenarios; null for built-ins. */
  readonly recognition: string | null;
  readonly builtin: boolean;
  /** Whether triage routes new matching tickets to the resolution agent. */
  readonly enabled: boolean;
  /** Remedy tools the agent may use for this scenario + their permission. */
  readonly enabledActions: ReadonlyArray<ScenarioActionView>;
  readonly supplierMode: SupplierModeView;
  /** Free-text playbook guidance injected verbatim into the agent. */
  readonly notes: string | null;
}

export interface ResolutionPolicyView {
  readonly scenarios: ReadonlyArray<ResolutionScenarioView>;
}

/**
 * One referenceable source, as surfaced to the scenario-notes editor. The
 * `namespace` says which menu it belongs to and how its chip reads:
 *   - a store fact (`returns`, `shipping`, …) or a knowledge doc (`docs`) — the
 *     `@` menu; `field` is null for a whole-block `@namespace` ref and the
 *     document id for a doc ref
 *   - an agent action (`actions`) — the `/` menu; `id` is the tool id the model
 *     calls (`refund.create`), `label` is the ONLY thing a merchant is shown
 *     ("Issue a refund"), and `field`/`value` are null: an action has no
 *     per-tenant value, so it can never dangle
 */
export interface FactReferenceEntryView {
  readonly id: string;
  readonly namespace: string;
  readonly field: string | null;
  readonly label: string;
  /**
   * This tenant's current value for the source, as the chip should display it:
   * a fact's mid-sentence value, or a knowledge doc's current title. Null when
   * the backing fact isn't set (which is what the chip and the dangling-ref
   * warning flag), and always null for an action.
   */
  readonly value: string | null;
}

export interface FactReferencesResponse {
  readonly entries: ReadonlyArray<FactReferenceEntryView>;
}

/**
 * The result of resolving `@`-references in a note against the tenant's facts
 * and knowledge docs — the exact agent-visible text plus the ids that did not
 * resolve (unset field, missing doc, or typo in a known namespace), for the
 * non-blocking dangling-ref warning.
 */
export interface ResolvedReferencesView {
  readonly resolved: string;
  readonly dangling: ReadonlyArray<string>;
}

// ============================================================
// Connector scope coverage (shared rule)
// ============================================================

/**
 * `fulfillmentTrackingInfoUpdate` accepts ANY ONE of Shopify's three
 * fulfillment-order write scopes. We request only the two that can apply to
 * this app: `write_merchant_managed_fulfillment_orders` (the merchant created
 * the fulfillment) and `write_third_party_fulfillment_orders` (a supplier /
 * 3PL did). The third, `write_assigned_fulfillment_orders`, is for apps
 * registered as a Shopify fulfillment service — which this app is not — so
 * requesting it would widen the merchant's consent screen for nothing.
 */
export const SHOPIFY_FULFILLMENT_TRACKING_SCOPES = [
  "write_merchant_managed_fulfillment_orders",
  "write_third_party_fulfillment_orders",
] as const;

export const SHOPIFY_FULFILLMENT_TRACKING_PERMISSION =
  "fulfill_and_ship_orders" as const;

/**
 * Whether `required` is covered by the `granted` scope list for a provider.
 * The single source of truth for both the runtime permission precheck
 * (`@support-agent/services`) and the dashboard's integrations capability grid.
 *
 * Shopify: every `write_X` scope implicitly covers `read_X` (Shopify's OAuth
 * callback omits the implied `read_X`). Other providers: literal match.
 */
export const isConnectorScopeGranted = (
  provider: string,
  required: string,
  granted: ReadonlyArray<string>,
): boolean => {
  if (granted.includes(required)) return true;
  if (provider === "shopify" && required.startsWith("read_")) {
    return granted.includes(`write_${required.slice("read_".length)}`);
  }
  return false;
};

// ============================================================
// Member RBAC — permission catalog + pure resolution (re-exported so the api
// and dashboard import everything from the package root).
// ============================================================

export {
  RBAC_PERMISSIONS,
  RBAC_PERMISSION_IDS,
  isRbacPermissionId,
} from "./rbac-permissions.js";
export type {
  RbacPermissionId,
  RbacPermissionCategory,
  RbacPermissionDef,
} from "./rbac-permissions.js";
export { effectivePermissions, hasPermission } from "./rbac-resolve.js";

// ============================================================
// Members & roles — GET/POST /dashboard/members, /roles, /invitations
// ============================================================
//
// A role is a merchant-editable named set of permission ids, scoped to one
// workspace. A member is a teammate assigned a role in this workspace. New
// members join via a WorkOS email invitation; until they accept, they appear
// as a pending invitation.

export interface RoleView {
  readonly id: string;
  readonly name: string;
  /** The all-access owner role: shown read-only (all permissions), undeletable. */
  readonly isOwner: boolean;
  /** Granted permission ids (raw, pre-implication). Owner roles report []. */
  readonly permissionIds: ReadonlyArray<RbacPermissionId>;
  /** Members currently assigned this role (for the "can't delete in use" guard). */
  readonly assignedMemberCount: number;
}

export interface MemberView {
  /** Stable per-user decision UUID (the api's x-user-id); the assignment key. */
  readonly userDecisionUuid: string;
  readonly email: string;
  readonly roleId: string;
  readonly roleName: string;
  readonly isOwner: boolean;
  readonly createdAt: string;
}

export type MemberInvitationStatus =
  | "pending"
  | "accepted"
  | "revoked"
  | "expired";

export interface MemberInvitationView {
  readonly id: string;
  readonly email: string;
  readonly roleId: string;
  readonly roleName: string;
  readonly status: MemberInvitationStatus;
  readonly createdAt: string;
}

export interface MembersResponse {
  readonly members: ReadonlyArray<MemberView>;
  readonly invitations: ReadonlyArray<MemberInvitationView>;
}

export interface RolesResponse {
  readonly roles: ReadonlyArray<RoleView>;
}

/** GET /dashboard/me/permissions — the acting member's own access. */
export interface MePermissionsResponse {
  readonly isOwner: boolean;
  /** Effective (post-implication) permission ids for the active workspace. */
  readonly permissions: ReadonlyArray<RbacPermissionId>;
  /** False when the member has no assignment row (workspace in "open" mode). */
  readonly assigned: boolean;
}
