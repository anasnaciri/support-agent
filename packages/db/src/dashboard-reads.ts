import { and, asc, desc, eq, gt, gte, like, lt, sql, type SQL } from "drizzle-orm";
import {
  clampPage,
  type AgentOverrideRow,
  type ApprovalDetail,
  type ApprovalListRow,
  type ApprovalsFilter,
  type ApprovalsListResult,
  type AuditEntry,
  type AuditFilter,
  type CaseDetail,
  type CaseEventsResult,
  type CaseListRow,
  type ConnectorConnectionView,
  type Page,
  type TodaySummary,
  type UsageDecisionRow,
} from "@support-agent/dashboard-contracts";
import type { DrizzleDb } from "./client.js";
import {
  approvals,
  auditLog,
  cases,
  connectorConnections,
  tenantAgentOverrides,
  tenants,
} from "./schema.js";

// Read queries backing the dashboard's HTTP API (Path B). The dashboard
// hosts on Cloudflare Workers and can't open a Postgres TCP pool, so these
// flat reads live here (where drizzle is a runtime dep) and are exposed by
// apps/api endpoints rather than run in the dashboard's Server Components.
//
// The JSON shapes these return live in `@support-agent/dashboard-contracts`
// (the shared, Worker-safe contract). The pagination helpers + every view
// type are re-exported here so existing `@support-agent/db` importers (the api
// edge) keep working unchanged.

export {
  PAGE_SIZE_OPTIONS,
  DEFAULT_PAGE_SIZE,
  parsePageSize,
  parsePageNumber,
  totalPagesFor,
  clampPage,
} from "@support-agent/dashboard-contracts";
export type {
  Page,
  TodayPendingApproval,
  TodayTakeoverCase,
  TodaySummary,
  CaseListRow,
  CaseDetailCase,
  AuditEntry,
  ApprovalDetail,
  CaseDetail,
  CaseEventsResult,
  ApprovalsFilter,
  ApprovalListRow,
  ApprovalsListResult,
  AuditFilter,
  ConnectorConnectionView,
  AgentOverrideRow,
  UsageDecisionRow,
} from "@support-agent/dashboard-contracts";

const TOP_N = 5;

/** Resolve the tenant a WorkOS organization is linked to, or null. */
export const findTenantIdByWorkosOrg = async (
  db: DrizzleDb,
  organizationId: string,
): Promise<string | null> => {
  const rows = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.workosOrganizationId, organizationId))
    .limit(1);
  return rows[0]?.id ?? null;
};

/**
 * Tenant id + name for a WorkOS org, or null when the org has no tenant yet.
 * Backs `GET /dashboard/tenant` (the dashboard maps null → /onboarding).
 */
export const tenantByWorkosOrg = async (
  db: DrizzleDb,
  organizationId: string,
): Promise<{ readonly id: string; readonly name: string } | null> => {
  const rows = await db
    .select({ id: tenants.id, name: tenants.name })
    .from(tenants)
    .where(eq(tenants.workosOrganizationId, organizationId))
    .limit(1);
  const row = rows[0];
  return row ? { id: row.id, name: row.name } : null;
};

export interface TenantDeletionSnapshot {
  readonly id: string;
  readonly name: string;
  /** WorkOS org to delete after the wipe; null for headless/Shopify-only tenants. */
  readonly workosOrganizationId: string | null;
  /** Where to send the deletion-confirmation email; null if none configured. */
  readonly notificationEmail: string | null;
}

/**
 * Capture the fields the deletion-cleanup job needs (org id + notification
 * email + name) BEFORE the tenant row is wiped — once `redactShop` runs,
 * the row is gone and these are unrecoverable. Returns null when the tenant
 * doesn't exist (already deleted / unknown id → 404 at the edge).
 */
export const tenantDeletionSnapshot = async (
  db: DrizzleDb,
  tenantId: string,
): Promise<TenantDeletionSnapshot | null> => {
  const rows = await db
    .select({
      id: tenants.id,
      name: tenants.name,
      workosOrganizationId: tenants.workosOrganizationId,
      settings: tenants.settings,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const settings = (row.settings ?? {}) as { notificationEmail?: unknown };
  return {
    id: row.id,
    name: row.name,
    workosOrganizationId: row.workosOrganizationId ?? null,
    notificationEmail:
      typeof settings.notificationEmail === "string"
        ? settings.notificationEmail
        : null,
  };
};

/** Today-view rollup for one tenant (counts + top-N approval/takeover lists). */
export const todaySummary = async (
  db: DrizzleDb,
  tenantId: string,
  now: Date = new Date(),
): Promise<TodaySummary> => {
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);

  const [byStatus, pending, takeover, resolvedToday] = await Promise.all([
    db
      .select({ status: cases.status, count: sql<number>`count(*)::int` })
      .from(cases)
      .where(eq(cases.tenantId, tenantId))
      .groupBy(cases.status),
    db
      .select({
        id: approvals.id,
        caseId: approvals.caseId,
        tool: approvals.tool,
        agentId: approvals.agentId,
        riskLevel: approvals.riskLevel,
        createdAt: approvals.createdAt,
      })
      .from(approvals)
      .where(
        and(eq(approvals.tenantId, tenantId), eq(approvals.status, "pending")),
      )
      .orderBy(desc(approvals.createdAt))
      .limit(TOP_N),
    db
      .select({
        id: cases.id,
        subject: cases.subject,
        category: cases.category,
        updatedAt: cases.updatedAt,
      })
      .from(cases)
      .where(
        and(
          eq(cases.tenantId, tenantId),
          eq(cases.status, "human_takeover"),
        ),
      )
      .orderBy(desc(cases.updatedAt))
      .limit(TOP_N),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(cases)
      .where(
        and(
          eq(cases.tenantId, tenantId),
          eq(cases.status, "resolved"),
          gte(cases.resolvedAt, dayStart),
        ),
      ),
  ]);

  const statusCounts: Record<string, number> = {};
  for (const row of byStatus) statusCounts[row.status] = row.count;

  return {
    statusCounts,
    resolvedTodayCount: resolvedToday[0]?.count ?? 0,
    pendingApprovals: pending.map((a) => ({
      id: a.id,
      caseId: a.caseId,
      tool: a.tool,
      agentId: a.agentId,
      riskLevel: a.riskLevel,
      createdAt: a.createdAt.toISOString(),
    })),
    takeoverCases: takeover.map((c) => ({
      id: c.id,
      subject: c.subject,
      category: c.category,
      updatedAt: c.updatedAt.toISOString(),
    })),
  };
};

// ============================================================
// Cases
// ============================================================

/** Paginated cases list for one tenant, newest activity first. */
export const casesList = async (
  db: DrizzleDb,
  tenantId: string,
  requestedPage: number,
  pageSize: number,
): Promise<Page<CaseListRow>> => {
  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(cases)
    .where(eq(cases.tenantId, tenantId));
  const totalRows = countRow?.count ?? 0;
  const page = clampPage(requestedPage, totalRows, pageSize);
  const rows = await db
    .select({
      id: cases.id,
      subject: cases.subject,
      status: cases.status,
      category: cases.category,
      currentAgentId: cases.currentAgentId,
      createdAt: cases.createdAt,
      updatedAt: cases.updatedAt,
    })
    .from(cases)
    .where(eq(cases.tenantId, tenantId))
    .orderBy(desc(cases.updatedAt), desc(cases.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return {
    totalRows,
    page,
    pageSize,
    rows: rows.map((r) => ({
      id: r.id,
      subject: r.subject,
      status: r.status,
      category: r.category,
      currentAgentId: r.currentAgentId,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    })),
  };
};

const toApprovalDetail = (a: typeof approvals.$inferSelect): ApprovalDetail => ({
  id: a.id,
  caseId: a.caseId,
  agentId: a.agentId,
  tool: a.tool,
  proposedInput: a.proposedInput,
  approvedInput: a.approvedInput,
  reasoning: a.reasoning,
  riskLevel: a.riskLevel,
  status: a.status,
  decidedBy: a.decidedBy,
  decidedAt: a.decidedAt ? a.decidedAt.toISOString() : null,
  decisionReason: a.decisionReason,
  expiresAt: a.expiresAt.toISOString(),
  createdAt: a.createdAt.toISOString(),
});

const toAuditEntry = (e: typeof auditLog.$inferSelect): AuditEntry => ({
  id: e.id.toString(),
  caseId: e.caseId,
  action: e.action,
  actorType: e.actorType,
  actorId: e.actorId,
  occurredAt: e.occurredAt.toISOString(),
  details: e.details,
});

/**
 * Full case detail: the case row, its complete audit timeline (ascending),
 * and its approvals. Returns null when the case isn't in the tenant (the
 * endpoint maps that to 404 — disclosure-safe). Shopify customer/order
 * panels are fetched via separate connector endpoints, not here.
 */
export const caseDetail = async (
  db: DrizzleDb,
  tenantId: string,
  caseId: string,
): Promise<CaseDetail | null> => {
  const [row] = await db
    .select()
    .from(cases)
    .where(and(eq(cases.id, caseId), eq(cases.tenantId, tenantId)))
    .limit(1);
  if (!row) return null;

  const [entries, caseApprovals] = await Promise.all([
    db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.caseId, caseId), eq(auditLog.tenantId, tenantId)))
      .orderBy(asc(auditLog.id)),
    db
      .select()
      .from(approvals)
      .where(and(eq(approvals.caseId, caseId), eq(approvals.tenantId, tenantId)))
      .orderBy(asc(approvals.createdAt)),
  ]);

  return {
    case: {
      id: row.id,
      subject: row.subject,
      status: row.status,
      category: row.category,
      currentAgentId: row.currentAgentId,
      priority: row.priority,
      summary: row.summary,
      context: row.context,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    },
    auditEntries: entries.map(toAuditEntry),
    approvals: caseApprovals.map(toApprovalDetail),
  };
};

/**
 * Audit rows for a case with id > `sinceId`, ascending (poll replacement for
 * the old SSE route). Returns null when the case isn't in the tenant (404).
 */
export const caseEvents = async (
  db: DrizzleDb,
  tenantId: string,
  caseId: string,
  sinceId: bigint,
): Promise<CaseEventsResult | null> => {
  const [caseRow] = await db
    .select({ id: cases.id })
    .from(cases)
    .where(and(eq(cases.id, caseId), eq(cases.tenantId, tenantId)))
    .limit(1);
  if (!caseRow) return null;

  const rows = await db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      actorType: auditLog.actorType,
      actorId: auditLog.actorId,
      occurredAt: auditLog.occurredAt,
    })
    .from(auditLog)
    .where(and(eq(auditLog.caseId, caseId), gt(auditLog.id, sinceId)))
    .orderBy(asc(auditLog.id))
    .limit(50);

  return {
    events: rows.map((r) => ({
      id: r.id.toString(),
      action: r.action,
      actorType: r.actorType,
      actorId: r.actorId,
      occurredAt: r.occurredAt.toISOString(),
    })),
  };
};

// ============================================================
// Approvals
// ============================================================

export const approvalsList = async (
  db: DrizzleDb,
  tenantId: string,
  filter: ApprovalsFilter,
  requestedPage: number,
  pageSize: number,
): Promise<ApprovalsListResult> => {
  const status = filter.status ?? "pending";
  const whereParts: SQL[] = [eq(approvals.tenantId, tenantId)];
  if (status !== "any") whereParts.push(eq(approvals.status, status));
  if (filter.risk) whereParts.push(eq(approvals.riskLevel, filter.risk));
  if (filter.tool) whereParts.push(eq(approvals.tool, filter.tool));
  if (filter.agent) whereParts.push(eq(approvals.agentId, filter.agent));
  const whereExpr = and(...whereParts);

  const [toolFacets, agentFacets, counts, matchingCount] = await Promise.all([
    db
      .selectDistinct({ tool: approvals.tool })
      .from(approvals)
      .where(eq(approvals.tenantId, tenantId))
      .orderBy(approvals.tool),
    db
      .selectDistinct({ agentId: approvals.agentId })
      .from(approvals)
      .where(eq(approvals.tenantId, tenantId))
      .orderBy(approvals.agentId),
    db
      .select({ status: approvals.status, count: sql<number>`count(*)::int` })
      .from(approvals)
      .where(eq(approvals.tenantId, tenantId))
      .groupBy(approvals.status),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(approvals)
      .where(whereExpr),
  ]);

  const totalRows = matchingCount[0]?.count ?? 0;
  const page = clampPage(requestedPage, totalRows, pageSize);
  const rows = await db
    .select({
      id: approvals.id,
      caseId: approvals.caseId,
      agentId: approvals.agentId,
      tool: approvals.tool,
      status: approvals.status,
      riskLevel: approvals.riskLevel,
      createdAt: approvals.createdAt,
      decidedAt: approvals.decidedAt,
    })
    .from(approvals)
    .where(whereExpr)
    .orderBy(desc(approvals.createdAt), desc(approvals.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const statusCounts: Record<string, number> = {};
  for (const c of counts) statusCounts[c.status] = c.count;

  return {
    totalRows,
    page,
    pageSize,
    rows: rows.map((r) => ({
      id: r.id,
      caseId: r.caseId,
      agentId: r.agentId,
      tool: r.tool,
      status: r.status,
      riskLevel: r.riskLevel,
      createdAt: r.createdAt.toISOString(),
      decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
    })),
    statusCounts,
    toolFacets: toolFacets.map((f) => f.tool),
    agentFacets: agentFacets.map((f) => f.agentId),
  };
};

/** Full approval by id, scoped to tenant. Null → 404. */
export const approvalDetail = async (
  db: DrizzleDb,
  tenantId: string,
  approvalId: string,
): Promise<ApprovalDetail | null> => {
  const [row] = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.id, approvalId), eq(approvals.tenantId, tenantId)))
    .limit(1);
  return row ? toApprovalDetail(row) : null;
};

// ============================================================
// Audit log
// ============================================================

export const auditList = async (
  db: DrizzleDb,
  tenantId: string,
  filter: AuditFilter,
  requestedPage: number,
  pageSize: number,
): Promise<Page<AuditEntry>> => {
  const whereParts: SQL[] = [eq(auditLog.tenantId, tenantId)];
  if (filter.action) whereParts.push(like(auditLog.action, `${filter.action}%`));
  if (filter.actor) whereParts.push(eq(auditLog.actorType, filter.actor));
  const whereExpr = and(...whereParts);

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(auditLog)
    .where(whereExpr);
  const totalRows = countRow?.count ?? 0;
  const page = clampPage(requestedPage, totalRows, pageSize);
  const rows = await db
    .select()
    .from(auditLog)
    .where(whereExpr)
    .orderBy(desc(auditLog.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return { totalRows, page, pageSize, rows: rows.map(toAuditEntry) };
};

// ============================================================
// Connector connections (integrations pages + case-detail shop domain)
// ============================================================

/**
 * All connector connections for a tenant (newest install first). Backs the
 * integrations overview + per-provider pages, and the case-detail Shopify
 * shop-domain deep link (the dashboard picks the active shopify row from
 * this). `shopDomain` defaults to "" in the schema; normalize empty → null.
 */
export const connectionsList = async (
  db: DrizzleDb,
  tenantId: string,
): Promise<ReadonlyArray<ConnectorConnectionView>> => {
  const rows = await db
    .select({
      id: connectorConnections.id,
      provider: connectorConnections.provider,
      shopDomain: connectorConnections.shopDomain,
      status: connectorConnections.status,
      scopes: connectorConnections.scopes,
      metadata: connectorConnections.metadata,
      installedAt: connectorConnections.installedAt,
      revokedAt: connectorConnections.revokedAt,
      updatedAt: connectorConnections.updatedAt,
    })
    .from(connectorConnections)
    .where(eq(connectorConnections.tenantId, tenantId))
    .orderBy(desc(connectorConnections.installedAt));
  return rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    shopDomain: r.shopDomain ? r.shopDomain : null,
    status: r.status,
    scopes: r.scopes ?? [],
    metadata: r.metadata,
    installedAt: r.installedAt ? r.installedAt.toISOString() : null,
    revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
    updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null,
  }));
};

/**
 * The agent-stamped `context` for a case (tenant-scoped). Null when the case
 * isn't in the tenant. Backs the case-detail Shopify panels, which read
 * `identifiedOrderId` / `shopifyCustomerId` / `customerEmail` from it.
 */
export const caseContextForTenant = async (
  db: DrizzleDb,
  tenantId: string,
  caseId: string,
): Promise<{ readonly context: unknown } | null> => {
  const [row] = await db
    .select({ context: cases.context })
    .from(cases)
    .where(and(eq(cases.id, caseId), eq(cases.tenantId, tenantId)))
    .limit(1);
  return row ? { context: row.context } : null;
};

/**
 * Per-agent model overrides for a tenant (the `settings/agents` pages). The
 * dashboard rebuilds its agentId→model map from this; agents without a row
 * fall back to their config default.
 */
export const agentOverrides = async (
  db: DrizzleDb,
  tenantId: string,
): Promise<ReadonlyArray<AgentOverrideRow>> => {
  const rows = await db
    .select({
      agentId: tenantAgentOverrides.agentId,
      model: tenantAgentOverrides.model,
    })
    .from(tenantAgentOverrides)
    .where(eq(tenantAgentOverrides.tenantId, tenantId));
  return rows.map((r) => ({ agentId: r.agentId, model: r.model }));
};

/** Shop domain of the tenant's active Shopify connection, or null. */
export const activeShopifyShopDomain = async (
  db: DrizzleDb,
  tenantId: string,
): Promise<string | null> => {
  const [row] = await db
    .select({ shopDomain: connectorConnections.shopDomain })
    .from(connectorConnections)
    .where(
      and(
        eq(connectorConnections.tenantId, tenantId),
        eq(connectorConnections.provider, "shopify"),
        eq(connectorConnections.status, "active"),
      ),
    )
    .limit(1);
  return row?.shopDomain ? row.shopDomain : null;
};

// ============================================================
// LLM usage (settings/usage). Returns the raw llm.decision audit rows in a
// time window; the dashboard applies OpenRouter pricing + aggregation
// (both pure / HTTP, fine on Workers).
// ============================================================

export const usageRows = async (
  db: DrizzleDb,
  tenantId: string,
  start: Date,
  end: Date,
): Promise<ReadonlyArray<UsageDecisionRow>> => {
  const rows = await db
    .select({ occurredAt: auditLog.occurredAt, details: auditLog.details })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenantId, tenantId),
        eq(auditLog.action, "llm.decision"),
        gte(auditLog.occurredAt, start),
        lt(auditLog.occurredAt, end),
      ),
    );
  return rows.map((r) => ({
    occurredAt: r.occurredAt.toISOString(),
    details: r.details,
  }));
};
