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
  readonly caseId: string;
  readonly tool: string;
  readonly agentId: string;
  readonly riskLevel: string;
  readonly createdAt: string;
}

export interface TodayTakeoverCase {
  readonly id: string;
  readonly subject: string | null;
  readonly category: string | null;
  readonly updatedAt: string;
}

export interface TodaySummary {
  /** Case count per status (raw; the view derives groupings like "in progress"). */
  readonly statusCounts: Record<string, number>;
  readonly resolvedTodayCount: number;
  readonly pendingApprovals: ReadonlyArray<TodayPendingApproval>;
  readonly takeoverCases: ReadonlyArray<TodayTakeoverCase>;
}

// ============================================================
// Cases
// ============================================================

export interface CaseListRow {
  readonly id: string;
  readonly subject: string | null;
  readonly status: string;
  readonly category: string | null;
  readonly currentAgentId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CasesFilter {
  /**
   * Free-text query matched (case-insensitive substring) against a case's
   * subject, summary, and category. Empty/absent means no filter.
   */
  readonly q?: string | undefined;
}

export interface CaseDetailCase {
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
}

export interface AuditEntry {
  readonly id: string;
  readonly caseId: string | null;
  readonly action: string;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly occurredAt: string;
  readonly details: unknown;
}

export interface ApprovalDetail {
  readonly id: string;
  readonly caseId: string;
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

export interface CaseDetail {
  readonly case: CaseDetailCase;
  readonly auditEntries: ReadonlyArray<AuditEntry>;
  readonly approvals: ReadonlyArray<ApprovalDetail>;
}

export interface DashboardConversationParticipant {
  readonly name: string | null;
  readonly email: string;
}

export interface DashboardConversationAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
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

export type CaseConversationThreadUnavailableReason =
  | "no_thread"
  | "thread_not_found"
  | "auth_required"
  | "mailbox_ambiguous"
  | "provider_unavailable";

export type CaseConversationThreadResult =
  | {
      readonly status: "available";
      readonly thread: DashboardConversationThread;
    }
  | {
      readonly status: "unavailable";
      readonly reason: CaseConversationThreadUnavailableReason;
    };

export interface CaseEventsResult {
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
  readonly caseId: string;
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
// Connector connections (integrations pages + case-detail shop domain)
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

/** One row in the admin tenant list. */
export interface AdminTenantSummary {
  readonly id: string;
  readonly name: string;
  readonly workosOrganizationId: string | null;
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
    readonly shopifyDomain: string | null;
    readonly createdAt: string;
  };
  readonly shopifyApp: {
    readonly clientId: string;
    readonly shopDomain: string | null;
    readonly status: ShopifyAppStatus;
    readonly updatedAt: string;
  } | null;
  readonly connections: ReadonlyArray<ConnectorConnectionView>;
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
}

export interface CatalogResponse {
  readonly agents: ReadonlyArray<AgentDto>;
  readonly tools: ReadonlyArray<ToolDto>;
}

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
// mailboxes, LLM credential, cases, knowledge, and settings. Requests pin a
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

export interface TenantSettingsView {
  readonly notificationEmail: string | null;
  readonly refundPolicy: RefundPolicyView;
  readonly retentionDays: number;
  readonly supplierEscalationSheet: SupplierEscalationSheetView | null;
  readonly legalAcceptance: LegalAcceptanceView | null;
}

// ============================================================
// Connector scope coverage (shared rule)
// ============================================================

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
