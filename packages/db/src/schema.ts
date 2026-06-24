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
    // Shopify connector).
    uniqueIndex("tenants_shopify_domain_unique")
      .on(t.shopifyDomain)
      .where(sql`${t.shopifyDomain} IS NOT NULL`),
    // A WorkOS organization owns MANY tenant rows — each row is one
    // "workspace" (its own store, mailboxes, LLM key, cases). Plain index
    // for the org→workspaces lookup; the "default" workspace is resolved
    // by ordering (created_at ASC, id ASC), not by a constraint.
    // Migration 0019 relaxed the previous 1:1 unique index.
    index("tenants_workos_org_idx")
      .on(t.workosOrganizationId)
      .where(sql`${t.workosOrganizationId} IS NOT NULL`),
  ],
);

/**
 * One inherited OpenRouter credential per WorkOS organization. Workspaces
 * (tenant rows) may still carry their own LLM row in connector_connections;
 * that row overrides this account default.
 *
 * There is intentionally no FK: WorkOS organizations are external ids, not
 * rows in this database. The final-workspace delete path removes this row in
 * the same transaction as the last tenant row.
 */
export const accountOpenrouterCredentials = pgTable(
  "account_openrouter_credentials",
  {
    organizationId: text("organization_id").primaryKey(),
    apiKeyEncrypted: bytea("api_key_encrypted").notNull(),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
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
      "account_openrouter_credentials_status_check",
      sql`${t.status} IN ('active','revoked')`,
    ),
    index("account_openrouter_credentials_active_idx")
      .on(t.organizationId)
      .where(sql`${t.status} = 'active'`),
  ],
);

export type AccountOpenRouterCredentialRow =
  typeof accountOpenrouterCredentials.$inferSelect;
export type AccountOpenRouterCredentialInsert =
  typeof accountOpenrouterCredentials.$inferInsert;

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
    // Exact connected mailbox that owns `thread_id`. Provider ids are opaque
    // within a mailbox, not guaranteed unique across two mailboxes.
    mailbox: text("mailbox"),
    // Conversation-connector discriminator stamped at case create (audit D2):
    // which provider owns `thread_id` (gmail/outlook/imap). NULL for cases
    // created before the stamp existed and for non-conversation channels.
    // The conversation router uses it to route legacy (un-namespaced) thread
    // ids instead of guessing the tenant's "most recent active connector".
    provider: text("provider"),
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
    // Mirrors CONVERSATION_PROVIDERS in @support-agent/services. NULL passes
    // the CHECK (unstamped legacy cases / non-conversation channels).
    check(
      "cases_provider_check",
      sql`${t.provider} IN ('gmail','outlook','imap')`,
    ),
    index("cases_tenant_status_idx").on(
      t.tenantId,
      t.status,
      sql`${t.updatedAt} DESC`,
    ),
    index("cases_customer_idx").on(t.customerId),
    // One case per exact mailbox thread. Provider thread ids are opaque and
    // can collide across two mailboxes connected by the same tenant.
    uniqueIndex("cases_tenant_provider_mailbox_thread_unique")
      .on(t.tenantId, t.provider, t.mailbox, t.threadId)
      .where(
        sql`${t.threadId} IS NOT NULL AND ${t.provider} IS NOT NULL AND ${t.mailbox} IS NOT NULL`,
      ),
    // Preserve uniqueness for pre-mailbox legacy cases until a future
    // backfill can bind them to a connection.
    uniqueIndex("cases_tenant_legacy_thread_unique")
      .on(t.tenantId, t.threadId)
      .where(sql`${t.threadId} IS NOT NULL AND ${t.mailbox} IS NULL`),
  ],
);

// RFC 5322 Message-ID ↔ case index. IMAP/SMTP has no provider-stable thread
// id, so a case's `thread_id` is reconstructed from the first inbound
// message's `References` header — brittle, because many clients reorder or
// drop that chain on subsequent replies, which would otherwise mint a
// duplicate case (the reply roots on a different id). We instead record the
// RFC Message-ID of every message we accept (inbound) and send (outbound)
// against its case; an incoming reply is correlated by matching ANY id in its
// In-Reply-To / References against this index. Recording BOTH directions is
// what makes a reply that only cites its immediate parent resolve — the parent
// is always either a prior inbound or our own outbound, both indexed here.
export const caseMessageIds = pgTable(
  "case_message_ids",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    /** RFC Message-ID, angle brackets stripped. */
    messageId: text("message_id").notNull(),
    direction: text("direction").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "case_message_ids_direction_check",
      sql`${t.direction} IN ('inbound','outbound')`,
    ),
    // A Message-ID is globally unique by RFC, so within a tenant it maps to at
    // most one case. The unique index doubles as the lookup index for
    // correlation and makes re-recording (redelivered poll / retried send)
    // idempotent via ON CONFLICT DO NOTHING.
    uniqueIndex("case_message_ids_tenant_message_unique").on(
      t.tenantId,
      t.messageId,
    ),
    index("case_message_ids_case_idx").on(t.caseId),
  ],
);

export type CaseMessageIdRow = typeof caseMessageIds.$inferSelect;
export type CaseMessageIdInsert = typeof caseMessageIds.$inferInsert;

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
    // Tenant-wide scans (dashboard auditList pagination keyed on id DESC and
    // the usage rollup filtering on action + occurred_at) on the fastest-
    // growing table — audit D5.
    index("audit_log_tenant_id_idx").on(t.tenantId, sql`${t.id} DESC`),
    index("audit_log_tenant_action_occurred_idx").on(
      t.tenantId,
      t.action,
      t.occurredAt,
    ),
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
    // Per-case approval lookups (caseDetail, takeover's pending-cancel scan)
    // — audit D5.
    index("approvals_case_idx").on(t.caseId),
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
      sql`${t.provider} IN ('shopify','gmail','google_sheets','outlook','imap','openrouter','anthropic','openai','telegram')`,
    ),
    uniqueIndex("connector_connections_tenant_provider_shop_idx").on(
      t.tenantId,
      t.provider,
      t.shopDomain,
    ),
    uniqueIndex("connector_connections_active_shopify_shop_unique")
      .on(t.provider, t.shopDomain)
      .where(sql`${t.provider} = 'shopify' AND ${t.status} = 'active'`),
    // One ACTIVE owner per mailbox across ALL tenants for the conversation
    // connectors (audit D1) — otherwise inbound-webhook tenant resolution
    // (e.g. findTenantByGmailMailbox) is plan-dependent and a customer's
    // email could be routed to the wrong tenant. Mirrors the shopify index
    // above; revoked rows are excluded so reconnect history survives.
    uniqueIndex("connector_connections_active_mailbox_unique")
      .on(t.provider, t.shopDomain)
      .where(
        sql`${t.provider} IN ('gmail','outlook','imap') AND ${t.status} = 'active'`,
      ),
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
    // Operator-pasted store-unique install link from the Shopify dev/Partner
    // dashboard (custom distribution). When present, the merchant's pilot
    // Connect redirects straight to it instead of a self-built OAuth authorize
    // URL. NULL when the operator hasn't supplied one (falls back to OAuth).
    installLink: text("install_link"),
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

// Merchant-authored custom agents (vs `tenant_agent_overrides`, which only
// patches the in-code built-ins). A row here is a WHOLE agent config the
// merchant built from the dashboard: its own instructions, tool set, handoff
// graph, and per-tool permissions. The runtime resolves it through the
// `AgentResolver` seam (built-ins first, then this table) and projects it to a
// full `AgentConfig` at read time — `instructions` stays RAW so the shared
// prompt scaffold can be re-applied on every read without a backfill.
//
// `agent_id` carries the reserved `custom:` prefix (e.g. `custom:V1StGXR8`) so a
// custom id can never shadow a bare built-in id, and it is text (no FK) for the
// same reason built-in ids are: agent ids are runtime identifiers, not rows in
// another table. Composite PK on (tenant_id, agent_id) keeps the same slug in
// two workspaces independent and makes upserts race-safe; the table is
// cascade-deleted with its tenant. `status` gates resolvability:
// `active` runs, `draft`/`disabled` are kept but never resolved (soft-delete).
// `mode`/`provider` are intentionally absent — every v1 custom agent is a
// `subagent` on the tenant BYOK `openrouter` path, so the resolver pins both.
export const tenantCustomAgents = pgTable(
  "tenant_custom_agents",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    // Merchant-authored RAW instructions — NOT the composed prompt. The
    // resolver wraps these in the shared scaffold at read time.
    instructions: text("instructions").notNull(),
    model: text("model").notNull(),
    // Tool NAMES (e.g. "shopify.get_order"). `agent.handoff` is implicit and
    // never stored here; the runtime always grants it.
    tools: jsonb("tools").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    // Outbound handoff targets (built-in or other custom ids in this workspace).
    handoffs: jsonb("handoffs")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Inbound opt-in (Phase C): agent ids this agent agrees to be callable FROM.
    callableFrom: jsonb("callable_from")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Per-tool "ask first" vs "auto" choices, same shape + semantics as
    // `tenant_agent_overrides.tool_permissions`. Overlays the resolved config's
    // permissionOverrides.
    permissionOverrides: jsonb("permission_overrides")
      .$type<Record<string, Permission>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    // One sentence the Phase C handoff roster shows a calling agent.
    whenToUse: text("when_to_use"),
    maxTurnsPerTick: integer("max_turns_per_tick").notNull().default(6),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.agentId] }),
    check(
      "tenant_custom_agents_status_check",
      sql`${t.status} IN ('draft','active','disabled')`,
    ),
    index("tenant_custom_agents_tenant_idx").on(t.tenantId),
  ],
);

export type TenantCustomAgentRow = typeof tenantCustomAgents.$inferSelect;
export type TenantCustomAgentInsert = typeof tenantCustomAgents.$inferInsert;

// Tenant-authored knowledge base: store policy / reference documents (shipping
// policy, returns policy, FAQs, …) the support agents consult at runtime via
// the `knowledge.search` tool. Dedicated table (NOT the `tenants.settings`
// JSONB blob) because `content` can be large. `source_type` distinguishes a
// raw pasted document from a URL the platform fetched + snapshotted: for a
// `url` doc, `source_url` is the fetched page and `content` is the extracted
// readable text, `fetched_at` stamps the last successful snapshot, and
// `content_hash` lets a re-sync no-op when the page is unchanged. Tenant-wide
// scope: every doc is available to all of the tenant's agents (no per-agent
// column). Cascade-deleted with the tenant.
export const tenantKnowledgeDocuments = pgTable(
  "tenant_knowledge_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    content: text("content").notNull(),
    sourceType: text("source_type").notNull(),
    sourceUrl: text("source_url"),
    contentHash: text("content_hash"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "tenant_knowledge_documents_source_type_check",
      sql`${t.sourceType} IN ('text','url')`,
    ),
    // Every read is `WHERE tenant_id = $1` (per-tick title load + dashboard
    // list + the tool's listFull).
    index("tenant_knowledge_documents_tenant_idx").on(t.tenantId),
  ],
);

export type TenantKnowledgeDocumentRow =
  typeof tenantKnowledgeDocuments.$inferSelect;
export type TenantKnowledgeDocumentInsert =
  typeof tenantKnowledgeDocuments.$inferInsert;

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
 * Processed-message dedup ledger (audit C3). Pub/Sub and Graph are
 * at-least-once; the runtime consults the UNIQUE (tenant, provider,
 * message_id) key at the top of a tick so a duplicate webhook delivery —
 * or the Gmail cursor-expiry reseed replaying history — can't run a second
 * full agent tick (and send a second customer reply) for the same inbound
 * message. `case_id` is informational (which case the message landed on);
 * SET NULL on case deletion so redaction isn't blocked while the dedup
 * record survives.
 */
export const processedMessages = pgTable(
  "processed_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    messageId: text("message_id").notNull(),
    threadId: text("thread_id"),
    caseId: uuid("case_id").references(() => cases.id, {
      onDelete: "set null",
    }),
    processedAt: timestamp("processed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("processed_messages_tenant_provider_message_unique").on(
      t.tenantId,
      t.provider,
      t.messageId,
    ),
  ],
);

export type ProcessedMessageRow = typeof processedMessages.$inferSelect;
export type ProcessedMessageInsert = typeof processedMessages.$inferInsert;

/**
 * Tool-execution markers (audit C2). A side-effecting tool records a row
 * keyed by (case_id, call_id) in the same transaction as its audit write;
 * an at-least-once redelivery (approval resume re-run, job retry) consults
 * the marker and short-circuits instead of double-executing a refund or
 * customer email. Cascades with the case (redaction).
 */
export const toolExecutions = pgTable(
  "tool_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    callId: text("call_id").notNull(),
    tool: text("tool").notNull(),
    executedAt: timestamp("executed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resultOk: boolean("result_ok"),
  },
  (t) => [
    uniqueIndex("tool_executions_case_call_unique").on(t.caseId, t.callId),
  ],
);

export type ToolExecutionRow = typeof toolExecutions.$inferSelect;
export type ToolExecutionInsert = typeof toolExecutions.$inferInsert;

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

// ============================================================
// Member RBAC — human teammates, roles, and per-workspace assignments.
//
// Distinct from the agent's tool-call permissions (those gate the AI). These
// tables gate which dashboard actions a human MEMBER may take. A role is a
// merchant-editable named set of permission ids (the ids come from the CODE
// registry in @support-agent/dashboard-contracts, so they're not FK'd here).
// Everything is per-workspace and cascade-deleted with the tenant.
// ============================================================

// One role per workspace = a named set of granted permission ids. `is_owner`
// marks the seeded all-access role (one per workspace, undeletable); the api
// short-circuits owners to every permission, so owner roles carry no
// role_permissions rows.
export const roles = pgTable(
  "roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    isOwner: boolean("is_owner").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // No two roles share a name (case-insensitive) within a workspace.
    uniqueIndex("roles_tenant_name_unique").on(
      t.tenantId,
      sql`lower(${t.name})`,
    ),
    // Exactly one owner role per workspace.
    uniqueIndex("roles_tenant_owner_unique")
      .on(t.tenantId)
      .where(sql`${t.isOwner}`),
    index("roles_tenant_idx").on(t.tenantId),
  ],
);

// A role's granted permission ids. `permission_id` is a value from the code
// registry (e.g. 'cases.reply'); deliberately not FK'd — the catalog is code.
export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionId: text("permission_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.permissionId] }),
    index("role_permissions_role_idx").on(t.roleId),
  ],
);

// Per-workspace member → role. Keyed on the decision UUID the dashboard sends
// as `x-user-id` (a one-way hash of the WorkOS user id; the api can't reverse
// it, so we key on it directly). `email` is for display/audit only. The role
// FK is ON DELETE RESTRICT so a role still assigned to someone can't be
// deleted out from under them (the api returns 409 role_in_use).
export const memberRoleAssignments = pgTable(
  "member_role_assignments",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userDecisionUuid: uuid("user_decision_uuid").notNull(),
    email: text("email").notNull(),
    workosUserId: text("workos_user_id"),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "restrict" }),
    invitedByUuid: uuid("invited_by_uuid"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.userDecisionUuid] }),
    index("member_role_assignments_tenant_idx").on(t.tenantId),
    index("member_role_assignments_role_idx").on(t.roleId),
  ],
);

// Pending email invitations. At invite time we have email + workspace + role
// but not the invitee's WorkOS user id — so the invite is keyed by email and
// reconciled into an assignment on the invitee's first authenticated load.
export const memberInvitations = pgTable(
  "member_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    workosInvitationId: text("workos_invitation_id"),
    invitedByUuid: uuid("invited_by_uuid"),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "member_invitations_status_check",
      sql`${t.status} IN ('pending','accepted','revoked','expired')`,
    ),
    // At most one OUTSTANDING invite per email per workspace (accepted/revoked
    // rows don't block re-inviting).
    uniqueIndex("member_invitations_tenant_email_pending_unique")
      .on(t.tenantId, sql`lower(${t.email})`)
      .where(sql`${t.status} = 'pending'`),
    index("member_invitations_tenant_idx").on(t.tenantId),
  ],
);

export type RoleRow = typeof roles.$inferSelect;
export type RoleInsert = typeof roles.$inferInsert;
export type RolePermissionRow = typeof rolePermissions.$inferSelect;
export type RolePermissionInsert = typeof rolePermissions.$inferInsert;
export type MemberRoleAssignmentRow =
  typeof memberRoleAssignments.$inferSelect;
export type MemberRoleAssignmentInsert =
  typeof memberRoleAssignments.$inferInsert;
export type MemberInvitationRow = typeof memberInvitations.$inferSelect;
export type MemberInvitationInsert = typeof memberInvitations.$inferInsert;

// ---------------------------------------------------------------------------
// Supplier portal (master-plan §19 / supplier-escalation loop)
// ---------------------------------------------------------------------------

// A supplier/warehouse entity scoped to one workspace (decision: one supplier ↔
// one workspace). Created at invite time so an escalation can target it before
// the supplier ever signs in; `user_decision_uuid` is bound on their first
// authenticated load (mirrors member_role_assignments). A supplier is a heavily
// constrained WorkOS member with the "Supplier" RBAC role — these rows just hold
// the named identity + the case-visibility binding.
export const suppliers = pgTable(
  "suppliers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    email: text("email").notNull(),
    userDecisionUuid: uuid("user_decision_uuid"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("suppliers_tenant_email_unique").on(
      t.tenantId,
      sql`lower(${t.email})`,
    ),
    // A WorkOS user maps to at most one supplier (one supplier ↔ one workspace).
    uniqueIndex("suppliers_user_unique")
      .on(t.userDecisionUuid)
      .where(sql`${t.userDecisionUuid} IS NOT NULL`),
    index("suppliers_tenant_idx").on(t.tenantId),
  ],
);

// The per-case escalation record + the MINIMAL privacy projection, denormalised
// at escalate time so the supplier query never joins back to cases / customer
// tables: the supplier sees the agent's problem statement, the order ref, the
// ship-to city/country, and the tracking number — never the customer email,
// full address, or conversation thread. `note`/`proposed_resolution` hold the
// supplier's reply. The notification ledger (`notified_at` / `notify_attempts`
// / `last_notify_error`) is the durable outbox the worker sweep relays.
export const caseSupplierEscalations = pgTable(
  "case_supplier_escalations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "restrict" }),
    problem: text("problem").notNull(),
    orderRef: text("order_ref"),
    shipCity: text("ship_city"),
    shipCountry: text("ship_country"),
    trackingNumber: text("tracking_number"),
    status: text("status").notNull().default("open"),
    note: text("note"),
    proposedResolution: text("proposed_resolution"),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    notifyAttempts: integer("notify_attempts").notNull().default(0),
    lastNotifyError: text("last_notify_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "case_supplier_escalations_status_check",
      sql`${t.status} IN ('open','resolved')`,
    ),
    // The supplier's "cases escalated to me" list.
    index("cse_supplier_status_idx").on(t.supplierId, t.status),
    index("cse_case_idx").on(t.caseId),
    index("cse_tenant_idx").on(t.tenantId),
    // The notification sweep scans unsent rows oldest-first.
    index("cse_unsent_idx")
      .on(t.createdAt)
      .where(sql`${t.notifiedAt} IS NULL`),
  ],
);

export type SupplierRow = typeof suppliers.$inferSelect;
export type SupplierInsert = typeof suppliers.$inferInsert;
export type CaseSupplierEscalationRow =
  typeof caseSupplierEscalations.$inferSelect;
export type CaseSupplierEscalationInsert =
  typeof caseSupplierEscalations.$inferInsert;

// The durable outbox for customer-reply DELIVERY (the SMTP/Gmail/Graph send),
// distinct from the supplier-notification outbox above. When a
// `conversation.reply` / `conversation.ask_customer` send FAILS — in the agent
// loop OR on approval-resume — the runtime persists the exact drafted message
// here instead of losing it: the case is flagged `reply_delivery_failed` and
// never resolved, a worker cron re-sends due rows with exponential backoff, and
// the dashboard "Retry sending email" button requeues one immediately. `draft`
// holds the verbatim tool input (to/subject/body/threadId/inReplyTo/draftId) so
// a retry re-sends the SAME email without re-running the LLM. On a successful
// send the row flips to `sent` and the case auto-resolves; at the attempt cap it
// flips to `abandoned` and the case parks in `human_takeover`.
export const replyDeliveries = pgTable(
  "reply_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    /** The send tool to replay: `conversation.reply` | `conversation.ask_customer`. */
    tool: text("tool").notNull(),
    /** Connected mailbox that owns the thread (the sender), or null. */
    mailbox: text("mailbox"),
    /** Stable per-draft id (from the tool input) — dedupes a re-run of the same failed send. */
    draftId: text("draft_id").notNull(),
    /** Verbatim tool input, replayed as-is on retry (no LLM re-run). */
    draft: jsonb("draft").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(6),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "reply_deliveries_status_check",
      sql`${t.status} IN ('pending','sent','abandoned')`,
    ),
    // The retry sweep scans due pending rows oldest-first.
    index("reply_deliveries_due_idx")
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'pending'`),
    // Per-case lookup (dashboard surfacing + manual retry).
    index("reply_deliveries_case_idx").on(t.caseId),
    index("reply_deliveries_tenant_idx").on(t.tenantId),
    // At most one in-flight delivery per draft, so a re-run of the same failed
    // send bumps the existing row instead of duplicating it.
    uniqueIndex("reply_deliveries_case_draft_pending_unique")
      .on(t.caseId, t.draftId)
      .where(sql`${t.status} = 'pending'`),
  ],
);

export type ReplyDeliveryRow = typeof replyDeliveries.$inferSelect;
export type ReplyDeliveryInsert = typeof replyDeliveries.$inferInsert;
