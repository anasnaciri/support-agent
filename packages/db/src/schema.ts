import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  shopifyDomain: text("shopify_domain"),
  settings: jsonb("settings").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

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
