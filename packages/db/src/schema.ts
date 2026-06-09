import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { Permission } from "@support-agent/agent-core";

// Postgres `bytea` is not in drizzle-orm/pg-core's first-class set; defining a
// minimal custom type keeps the column typed as `Buffer` in TS so we don't
// accidentally store base64 / hex strings.
const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    shopifyDomain: text("shopify_domain"),
    // WorkOS organization id (`org_…`). The dashboard maps a signed-in
    // user's `organizationId` to `tenants.id` through this column. NULL
    // for tenants with a Shopify install but no dashboard manager yet,
    // or headless API-only tenants. Migration 0004.
    workosOrganizationId: text("workos_organization_id"),
    settings: jsonb("settings").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // One tenant per Shopify shop. Partial index — NULL is allowed for
    // tenants that don't have a Shopify connection yet (or use a non-
    // Shopify connector). The callback's `resolveTenantByShop` relies on
    // this constraint to make the upsert race-safe.
    uniqueIndex("tenants_shopify_domain_unique")
      .on(t.shopifyDomain)
      .where(sql`${t.shopifyDomain} IS NOT NULL`),
    // One tenant per WorkOS organization. Same partial-index pattern.
    uniqueIndex("tenants_workos_org_unique")
      .on(t.workosOrganizationId)
      .where(sql`${t.workosOrganizationId} IS NOT NULL`),
  ],
);

export const cases = pgTable(
  "cases",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    customerId: uuid("customer_id"),
    shopifyOrderId: text("shopify_order_id"),
    channel: text("channel").notNull(),
    threadId: text("thread_id"),
    category: text("category"),
    status: text("status").notNull(),
    currentAgentId: text("current_agent_id").notNull(),
    priority: text("priority").notNull().default("normal"),
    summary: text("summary"),
    subject: text("subject"),
    context: jsonb("context").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "cases_channel_check",
      sql`${t.channel} IN ('email','form','chat','api')`,
    ),
    check(
      "cases_priority_check",
      sql`${t.priority} IN ('low','normal','high','urgent')`,
    ),
    check(
      "cases_status_check",
      sql`${t.status} IN ('new','triaging','in_progress','waiting_for_customer','waiting_for_supplier','waiting_for_approval','approved_action_running','resolved','failed','human_takeover')`,
    ),
    index("cases_tenant_status_idx").on(
      t.tenantId,
      t.status,
      sql`${t.updatedAt} DESC`,
    ),
    index("cases_customer_idx").on(t.customerId),
  ],
);

export const caseStateTransitions = pgTable(
  "case_state_transitions",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    fromStatus: text("from_status").notNull(),
    toStatus: text("to_status").notNull(),
    eventId: uuid("event_id"),
    reason: text("reason"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("cst_case_idx").on(t.caseId, t.id)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    caseId: uuid("case_id"),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    details: jsonb("details").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "audit_log_actor_type_check",
      sql`${t.actorType} IN ('agent','user','system','customer')`,
    ),
    index("audit_log_case_idx").on(t.caseId, t.id),
  ],
);

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id),
    agentId: text("agent_id").notNull(),
    tool: text("tool").notNull(),
    proposedInput: jsonb("proposed_input").notNull(),
    approvedInput: jsonb("approved_input"),
    reasoning: text("reasoning"),
    riskLevel: text("risk_level").notNull(),
    status: text("status").notNull(),
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionReason: text("decision_reason"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "approvals_risk_level_check",
      sql`${t.riskLevel} IN ('low','medium','high','critical')`,
    ),
    check(
      "approvals_status_check",
      sql`${t.status} IN ('pending','approved','rejected','expired','cancelled')`,
    ),
    index("approvals_pending_idx")
      .on(t.tenantId, t.status, t.expiresAt)
      .where(sql`${t.status} = 'pending'`),
  ],
);

/**
 * Per-tenant credentials for external connectors (Shopify, Gmail, …). Stores
 * the encrypted access token + scopes granted at install time. One row per
 * (tenant, provider, shop_domain). For non-shoppable connectors `shop_domain`
 * is `''` (empty string) — we still want it in the unique key so the same
 * tenant can install multiple Shopify shops or multiple Gmail mailboxes.
 *
 * `access_token_encrypted` (and `refresh_token_encrypted` when present)
 * layout: iv (12) || gcm_tag (16) || ciphertext. See
 * `packages/services/src/crypto.ts`.
 *
 * OAuth-shaped connectors (Gmail, Outlook) hand back short-lived access
 * tokens + long-lived refresh tokens; we encrypt both columns. Shopify's
 * managed-install offline access token never expires, so `refresh_token_*`
 * stays null and `token_expires_at` stays null for it.
 *
 * `metadata` is a per-connector JSON blob for state that doesn't deserve
 * its own column. Today: Gmail's `historyId` (last successfully processed
 * mailbox history cursor) and `watchExpiresAt` (Gmail watch lease expiry).
 */
export const connectorConnections = pgTable(
  "connector_connections",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    shopDomain: text("shop_domain").notNull().default(""),
    accessTokenEncrypted: bytea("access_token_encrypted").notNull(),
    refreshTokenEncrypted: bytea("refresh_token_encrypted"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
    apiVersion: text("api_version"),
    status: text("status").notNull().default("active"),
    installedAt: timestamp("installed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "connector_connections_status_check",
      sql`${t.status} IN ('active','revoked')`,
    ),
    check(
      "connector_connections_provider_check",
      sql`${t.provider} IN ('shopify','gmail','google_sheets','outlook','openrouter','anthropic','openai')`,
    ),
    uniqueIndex("connector_connections_tenant_provider_shop_idx").on(
      t.tenantId,
      t.provider,
      t.shopDomain,
    ),
    uniqueIndex("connector_connections_active_shopify_shop_unique")
      .on(t.provider, t.shopDomain)
      .where(sql`${t.provider} = 'shopify' AND ${t.status} = 'active'`),
    // BYOK: at most one active LLM provider per tenant. The provider field
    // names the chosen one (openrouter/anthropic/openai); only one of those
    // three rows may carry status='active' at a time, so a tenant can't
    // accidentally have two routing destinations live.
    uniqueIndex("connector_connections_active_llm_per_tenant_unique")
      .on(t.tenantId)
      .where(
        sql`${t.provider} IN ('openrouter','anthropic','openai') AND ${t.status} = 'active'`,
      ),
    index("connector_connections_active_idx")
      .on(t.tenantId, t.provider)
      .where(sql`${t.status} = 'active'`),
  ],
);

export type ConnectorConnectionRow =
  typeof connectorConnections.$inferSelect;
export type ConnectorConnectionInsert =
  typeof connectorConnections.$inferInsert;

// Pilot custom-distribution Shopify: one operator-provisioned Shopify custom
// app per tenant. Holds the *app* credentials (client_id + encrypted
// client_secret) — the layer ABOVE the per-merchant access token in
// `connector_connections`. Presence of a row is the pilot-vs-SaaS switch: a
// tenant with a row uses its own app; a tenant without one falls back to the
// global env app. `shop_domain` is NULL until the merchant completes Connect
// (learned at the OAuth callback). See master-plan §19.6.
export const shopifyAppProvisioning = pgTable(
  "shopify_app_provisioning",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    clientSecretEncrypted: bytea("client_secret_encrypted").notNull(),
    shopDomain: text("shop_domain"),
    status: text("status").notNull().default("ready"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "shopify_app_provisioning_status_check",
      sql`${t.status} IN ('ready','connected','revoked')`,
    ),
    // Exactly one custom app per tenant.
    uniqueIndex("shopify_app_provisioning_tenant_unique").on(t.tenantId),
    // Webhooks resolve the app secret by shop domain once it's learned.
    index("shopify_app_provisioning_shop_idx")
      .on(t.shopDomain)
      .where(sql`${t.shopDomain} IS NOT NULL`),
    // At most ONE non-revoked (active) row per shop, so webhook secret
    // routing is deterministic — a shop transferred between tenants can't
    // leave two live rows for the same shop (A3). Revoked rows are excluded
    // so a stale row keeps its shop_domain for late compliance webhooks
    // without shadowing the live row.
    uniqueIndex("shopify_app_provisioning_active_shop_unique")
      .on(t.shopDomain)
      .where(sql`${t.shopDomain} IS NOT NULL AND ${t.status} <> 'revoked'`),
  ],
);

export type ShopifyAppProvisioningRow =
  typeof shopifyAppProvisioning.$inferSelect;
export type ShopifyAppProvisioningInsert =
  typeof shopifyAppProvisioning.$inferInsert;

// Per-tenant per-agent overrides applied on top of the in-code AgentConfig.
// `model` overrides AgentConfig.model; `system_prompt` is tenant-authored text
// appended to AgentConfig.promptTemplate (extra instructions — brand voice,
// policy, tone — not a replacement, so the agent keeps its tool/handoff/
// approval scaffolding). Both are nullable and share ONE row per pair, so
// clears are field-aware (null one column; the row is removed only when both
// are null). The table is still structured to grow (temperature, maxTurns, …)
// without another migration. `agent_id` is text (no FK) because agent configs
// live in code; this row carries a string that maps to AgentConfig.id at
// runtime. Composite PK on (tenant_id, agent_id) makes upserts race-safe.
export const tenantAgentOverrides = pgTable(
  "tenant_agent_overrides",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    model: text("model"),
    systemPrompt: text("system_prompt"),
    // Per-tool "ask first" vs "auto" choices for this agent, keyed by tool
    // name (e.g. { "conversation.reply": "allow" }). Null when the tenant
    // hasn't overridden any tool. The runtime overlays this onto the agent's
    // permissionOverrides; only `permission-toggle` tools ever land here.
    toolPermissions: jsonb("tool_permissions").$type<
      Record<string, Permission>
    >(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.agentId] }),
  ],
);

export type TenantAgentOverrideRow =
  typeof tenantAgentOverrides.$inferSelect;
export type TenantAgentOverrideInsert =
  typeof tenantAgentOverrides.$inferInsert;

// Platform-operator audit log. Deliberately NOT tenant-scoped and with NO
// FK to `tenants` — these rows must SURVIVE a tenant wipe so a privileged
// action (above all, deleting a tenant) leaves a permanent record. The
// per-tenant `audit_log` is wiped with the tenant, so it can't hold the
// deletion record itself. See master-plan §13 ("every admin mutation must
// write an audit row") + re-audit #2. `actor` is the operator identity
// (today the shared-password console writes "admin"; a self-service tenant
// deletion writes "tenant_self").
export const adminAuditLog = pgTable(
  "admin_audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    action: text("action").notNull(),
    // The tenant the action targeted. No FK — the tenant row may be gone.
    targetTenantId: uuid("target_tenant_id"),
    actor: text("actor").notNull(),
    details: jsonb("details")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("admin_audit_log_target_idx").on(t.targetTenantId),
    index("admin_audit_log_created_idx").on(t.createdAt),
  ],
);

export type AdminAuditLogRow = typeof adminAuditLog.$inferSelect;
export type AdminAuditLogInsert = typeof adminAuditLog.$inferInsert;

export const timers = pgTable(
  "timers",
  {
    id: uuid("id").primaryKey(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    fireAt: timestamp("fire_at", { withTimezone: true }).notNull(),
    reason: text("reason").notNull(),
    firedAt: timestamp("fired_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "timers_reason_check",
      sql`${t.reason} IN ('follow_up','sla','escalation')`,
    ),
    index("timers_due_idx")
      .on(t.fireAt)
      .where(sql`${t.firedAt} IS NULL AND ${t.cancelledAt} IS NULL`),
    index("timers_case_idx").on(t.caseId, t.fireAt),
  ],
);

export type TimerRow = typeof timers.$inferSelect;
export type TimerInsert = typeof timers.$inferInsert;

/**
 * Perceptual hashes of customer photo attachments — backs the damaged-
 * product duplicate-photo fraud guard. One row per uploaded image. `phash`
 * is a 64-bit dHash stored as a signed `bigint` (two's-complement bit
 * pattern; Hamming distance is computed on the bits, so the sign is
 * irrelevant). We keep ONLY the hash, the case, and the tenant — never the
 * image — and a hash is not reversible to the original photo. Lookups
 * fetch a tenant's recent window (see the composite index) and compute
 * Hamming distance in app code.
 */
export const imageHashes = pgTable(
  "image_hashes",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    phash: bigint("phash", { mode: "bigint" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("image_hashes_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("image_hashes_case_idx").on(t.caseId),
  ],
);

export type ImageHashRow = typeof imageHashes.$inferSelect;
export type ImageHashInsert = typeof imageHashes.$inferInsert;

export type TenantRow = typeof tenants.$inferSelect;
export type TenantInsert = typeof tenants.$inferInsert;
export type CaseRow = typeof cases.$inferSelect;
export type CaseInsert = typeof cases.$inferInsert;
export type CaseStateTransitionRow = typeof caseStateTransitions.$inferSelect;
export type CaseStateTransitionInsert =
  typeof caseStateTransitions.$inferInsert;
export type AuditLogRow = typeof auditLog.$inferSelect;
export type AuditLogInsert = typeof auditLog.$inferInsert;
export type ApprovalRow = typeof approvals.$inferSelect;
export type ApprovalInsert = typeof approvals.$inferInsert;
