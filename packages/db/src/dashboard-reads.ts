import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  gte,
  ilike,
  inArray,
  like,
  lt,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  clampPage,
  type AgentOverrideRow,
  type ApprovalDetail,
  type ApprovalListRow,
  type ApprovalsFilter,
  type ApprovalsListResult,
  type AuditEntry,
  type AuditFilter,
  type TicketDetail,
  type TicketDetailReplyDelivery,
  type TicketsFilter,
  type TicketEventsResult,
  type TicketListRow,
  type ConnectorConnectionView,
  type KnowledgeDocumentSummaryView,
  type KnowledgeSourceType,
  type Page,
  type TodaySummary,
  type UsageDecisionRow,
  type SupportAnalytics,
  type DeliveryAnalytics,
} from "@support-agent/dashboard-contracts";
import {
  allowedManualStatusTargets,
  type TicketStatus,
} from "@support-agent/agent-core";
import {
  decodeOnboardingState,
  onboardingPending,
} from "@support-agent/services";
import type { DrizzleDb } from "./client.js";
import {
  approvals,
  auditLog,
  ticketFulfillmentOperatorEscalations,
  tickets,
  connectorConnections,
  tenantAgentOverrides,
  tenantKnowledgeDocuments,
  tenants,
  replyDeliveries,
  shipments,
} from "./schema.js";
import { hasOpenEscalationForTicket } from "./fulfillment-operator-store.js";
import { getActiveReplyDeliveryForTicket } from "./reply-delivery-store.js";
import { resurfaceableApprovedReply } from "./approved-not-sent.js";

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
  TodayTakeoverTicket,
  TodaySummary,
  TicketListRow,
  TicketDetailTicket,
  TicketDetailReplyDelivery,
  AuditEntry,
  ApprovalDetail,
  TicketDetail,
  TicketEventsResult,
  ApprovalsFilter,
  ApprovalListRow,
  ApprovalsListResult,
  AuditFilter,
  ConnectorConnectionView,
  AgentOverrideRow,
  KnowledgeDocumentSummaryView,
  UsageDecisionRow,
  SupportAnalytics,
  DeliveryAnalytics,
} from "@support-agent/dashboard-contracts";

const TOP_N = 5;

const toTicketDetailReplyDelivery = (
  row: Awaited<ReturnType<typeof getActiveReplyDeliveryForTicket>>,
): TicketDetailReplyDelivery | null =>
  row
    ? {
        id: row.id,
        ticketId: row.ticketId,
        status: row.status,
        tool: row.tool,
        mailbox: row.mailbox,
        draftId: row.draftId,
        attempts: row.attempts,
        maxAttempts: row.maxAttempts,
        lastError: row.lastError,
        nextAttemptAt: row.nextAttemptAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }
    : null;

// An org owns many workspaces (tenant rows). The "default" workspace — what
// a request without an explicit workspace resolves to — is the OLDEST row,
// id ASC tiebreak. The ordering is load-bearing: without it, two rows per
// org would make these lookups plan-dependent.
const defaultWorkspaceOrder = [asc(tenants.createdAt), asc(tenants.id)];

/**
 * Resolve the org's DEFAULT workspace (oldest tenant row), or null when the
 * org has none yet.
 */
export const findTenantIdByWorkosOrg = async (
  db: DrizzleDb,
  organizationId: string,
): Promise<string | null> => {
  const rows = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.workosOrganizationId, organizationId))
    .orderBy(...defaultWorkspaceOrder)
    .limit(1);
  return rows[0]?.id ?? null;
};

/**
 * Default-workspace id + name for a WorkOS org, or null when the org has no
 * tenant yet. Backs `GET /dashboard/tenant` (the dashboard maps null →
 * /onboarding).
 */
export const tenantByWorkosOrg = async (
  db: DrizzleDb,
  organizationId: string,
): Promise<{ readonly id: string; readonly name: string } | null> => {
  const rows = await db
    .select({ id: tenants.id, name: tenants.name })
    .from(tenants)
    .where(eq(tenants.workosOrganizationId, organizationId))
    .orderBy(...defaultWorkspaceOrder)
    .limit(1);
  const row = rows[0];
  return row ? { id: row.id, name: row.name } : null;
};

export interface WorkspaceRow {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;
  readonly shopifyDomain: string | null;
  /**
   * Setup wizard still owed for this workspace. Derived from the row's
   * `settings.onboarding` block so the dashboard's bootstrap list can gate the
   * shell without a second round trip. Always false for a workspace created
   * before the wizard existed (no block).
   */
  readonly onboardingPending: boolean;
}

/**
 * All workspaces (tenant rows) of a WorkOS org, default first. Backs
 * `GET /dashboard/workspaces` and the dashboard's workspace switcher.
 */
export const listWorkspacesByWorkosOrg = async (
  db: DrizzleDb,
  organizationId: string,
): Promise<ReadonlyArray<WorkspaceRow>> => {
  const rows = await db
    .select({
      id: tenants.id,
      name: tenants.name,
      createdAt: tenants.createdAt,
      shopifyDomain: tenants.shopifyDomain,
      settings: tenants.settings,
    })
    .from(tenants)
    .where(eq(tenants.workosOrganizationId, organizationId))
    .orderBy(...defaultWorkspaceOrder);
  return rows.map(({ settings, ...row }) => ({
    ...row,
    onboardingPending: onboardingPending(
      decodeOnboardingState(
        (settings as { readonly onboarding?: unknown } | null)?.onboarding,
      ),
    ),
  }));
};

/**
 * A single workspace IF the org owns it, else null — the ownership check
 * behind the `x-workspace-id` header and the rename/delete endpoints.
 */
export const findWorkspaceForOrg = async (
  db: DrizzleDb,
  organizationId: string,
  workspaceId: string,
): Promise<{ readonly id: string; readonly name: string } | null> => {
  const rows = await db
    .select({ id: tenants.id, name: tenants.name })
    .from(tenants)
    .where(
      and(
        eq(tenants.workosOrganizationId, organizationId),
        eq(tenants.id, workspaceId),
      ),
    )
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
  // "Today" starts at UTC midnight (audit D11): server-local midnight made
  // the rollup depend on wherever the API process happens to run. UTC is a
  // deliberate simplification until tenants carry a timezone setting — when
  // they do, compute this boundary in the tenant's zone instead.
  const dayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );

  const [byStatus, pending, takeover, resolvedToday] = await Promise.all([
    db
      .select({ status: tickets.status, count: sql<number>`count(*)::int` })
      .from(tickets)
      .where(eq(tickets.tenantId, tenantId))
      .groupBy(tickets.status),
    db
      .select({
        id: approvals.id,
        ticketId: approvals.ticketId,
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
        id: tickets.id,
        subject: tickets.subject,
        scenarioKey: sql<string | null>`${tickets.context}->>'scenarioKey'`,
        updatedAt: tickets.updatedAt,
      })
      .from(tickets)
      .where(
        and(
          eq(tickets.tenantId, tenantId),
          eq(tickets.status, "human_takeover"),
        ),
      )
      .orderBy(desc(tickets.updatedAt))
      .limit(TOP_N),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(tickets)
      .where(
        and(
          eq(tickets.tenantId, tenantId),
          eq(tickets.status, "resolved"),
          gte(tickets.resolvedAt, dayStart),
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
      ticketId: a.ticketId,
      tool: a.tool,
      agentId: a.agentId,
      riskLevel: a.riskLevel,
      createdAt: a.createdAt.toISOString(),
    })),
    takeoverTickets: takeover.map((c) => ({
      id: c.id,
      subject: c.subject,
      scenarioKey: c.scenarioKey,
      updatedAt: c.updatedAt.toISOString(),
    })),
  };
};

const analyticsPercentage = (count: number, total: number): number =>
  total === 0 ? 0 : Math.round((count / total) * 1_000) / 10;

/**
 * Merchant-facing support operations analytics.
 *
 * Cohort measures are anchored on tickets CREATED in [start, end), while
 * activity measures are anchored on events DECIDED in that same window. This
 * distinction is part of the interface: it prevents an old ticket resolved
 * today from silently changing the denominator of today's intake quality.
 */
export const supportAnalytics = async (
  db: DrizzleDb,
  tenantId: string,
  period: { readonly start: Date; readonly end: Date },
): Promise<SupportAnalytics> => {
  const manualHandling = exists(
    db
      .select({ one: sql`1` })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantId),
          eq(auditLog.ticketId, tickets.id),
          eq(auditLog.actorType, "user"),
          or(
            eq(auditLog.action, "ticket.replied"),
            and(
              eq(auditLog.action, "ticket.resolved"),
              sql`coalesce(${auditLog.details}->>'reason', '') NOT LIKE 'approved %'`,
            ),
          ),
        ),
      ),
  );
  const merchantTakeover = exists(
    db
      .select({ one: sql`1` })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantId),
          eq(auditLog.ticketId, tickets.id),
          eq(auditLog.action, "ticket.taken_over"),
        ),
      ),
  );
  const automaticEscalation = exists(
    db
      .select({ one: sql`1` })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantId),
          eq(auditLog.ticketId, tickets.id),
          eq(auditLog.action, "ticket.escalated_to_human"),
        ),
      ),
  );
  const cohortWhere = and(
    eq(tickets.tenantId, tenantId),
    gte(tickets.createdAt, period.start),
    lt(tickets.createdAt, period.end),
  );
  const firstResponseTimes = db
    .select({
      minutes:
        sql<number>`extract(epoch FROM (min(${auditLog.occurredAt}) - ${tickets.createdAt})) / 60.0`.as(
          "minutes",
        ),
    })
    .from(tickets)
    .innerJoin(
      auditLog,
      and(
        eq(auditLog.tenantId, tickets.tenantId),
        eq(auditLog.ticketId, tickets.id),
      ),
    )
    .where(
      and(
        cohortWhere,
        or(
          and(
            eq(auditLog.action, "tool.invoked"),
            sql`${auditLog.details}->>'tool' IN ('conversation.reply', 'conversation.ask_customer')`,
            sql`${auditLog.details}->>'ok' = 'true'`,
          ),
          and(
            eq(auditLog.action, "ticket.replied"),
            eq(auditLog.actorType, "user"),
          ),
        ),
      ),
    )
    .groupBy(tickets.id, tickets.createdAt)
    .as("first_response_times");

  const [
    cohortRows,
    scenarioRows,
    draftRows,
    activityRows,
    firstResponseRows,
    approvalWaitRows,
    refundRows,
    deliveryRows,
    backlogRows,
  ] = await Promise.all([
    db
      .select({
        total: sql<number>`count(*)::int`,
        resolved: sql<number>`count(*) FILTER (WHERE ${tickets.resolvedAt} IS NOT NULL)::int`,
        merchantTakeovers: sql<number>`count(*) FILTER (WHERE ${merchantTakeover})::int`,
        automaticEscalations: sql<number>`count(*) FILTER (WHERE ${automaticEscalation})::int`,
        handedOff: sql<number>`count(*) FILTER (WHERE ${merchantTakeover} OR ${automaticEscalation})::int`,
        humanHandled: sql<number>`count(*) FILTER (WHERE ${manualHandling})::int`,
        agentAssisted: sql<number>`count(*) FILTER (
          WHERE ${tickets.resolvedAt} IS NOT NULL AND NOT ${manualHandling}
        )::int`,
        unresolved: sql<number>`count(*) FILTER (
          WHERE ${tickets.resolvedAt} IS NULL AND NOT ${manualHandling}
        )::int`,
        unclassified: sql<number>`count(*) FILTER (
          WHERE nullif(${tickets.context}->>'scenarioKey', '') IS NULL
        )::int`,
      })
      .from(tickets)
      .where(cohortWhere),
    db
      .select({
        scenarioKey: sql<string>`${tickets.context}->>'scenarioKey'`,
        count: sql<number>`count(*)::int`,
      })
      .from(tickets)
      .where(
        and(
          cohortWhere,
          sql`nullif(${tickets.context}->>'scenarioKey', '') IS NOT NULL`,
        ),
      )
      .groupBy(sql`${tickets.context}->>'scenarioKey'`)
      .orderBy(desc(sql`count(*)`), asc(sql`${tickets.context}->>'scenarioKey'`))
      .limit(10),
    db
      .select({
        decided: sql<number>`count(*)::int`,
        accepted: sql<number>`count(*) FILTER (WHERE ${approvals.status} = 'approved')::int`,
        acceptedWithoutEdit: sql<number>`count(*) FILTER (
          WHERE ${approvals.status} = 'approved'
            AND (${approvals.approvedInput} IS NULL OR ${approvals.approvedInput} = ${approvals.proposedInput})
        )::int`,
        editedThenAccepted: sql<number>`count(*) FILTER (
          WHERE ${approvals.status} = 'approved'
            AND ${approvals.approvedInput} IS NOT NULL
            AND ${approvals.approvedInput} <> ${approvals.proposedInput}
        )::int`,
        declined: sql<number>`count(*) FILTER (WHERE ${approvals.status} = 'rejected')::int`,
      })
      .from(approvals)
      .where(
        and(
          eq(approvals.tenantId, tenantId),
          inArray(approvals.tool, [
            "conversation.reply",
            "conversation.ask_customer",
          ]),
          inArray(approvals.status, ["approved", "rejected"]),
          gte(approvals.decidedAt, period.start),
          lt(approvals.decidedAt, period.end),
        ),
      ),
    db
      .select({
        ticketsResolved: sql<number>`count(*)::int`,
        medianResolutionMinutes: sql<number | null>`
          percentile_cont(0.5) WITHIN GROUP (
            ORDER BY extract(epoch FROM (${tickets.resolvedAt} - ${tickets.createdAt})) / 60.0
          )
        `,
      })
      .from(tickets)
      .where(
        and(
          eq(tickets.tenantId, tenantId),
          gte(tickets.resolvedAt, period.start),
          lt(tickets.resolvedAt, period.end),
        ),
      ),
    db
      .select({
        median: sql<number | null>`
          percentile_cont(0.5) WITHIN GROUP (ORDER BY ${firstResponseTimes.minutes})
        `,
      })
      .from(firstResponseTimes),
    db
      .select({
        median: sql<number | null>`
          percentile_cont(0.5) WITHIN GROUP (
            ORDER BY extract(epoch FROM (${approvals.decidedAt} - ${approvals.createdAt})) / 60.0
          )
        `,
      })
      .from(approvals)
      .where(
        and(
          eq(approvals.tenantId, tenantId),
          inArray(approvals.status, ["approved", "rejected"]),
          gte(approvals.decidedAt, period.start),
          lt(approvals.decidedAt, period.end),
        ),
      ),
    db
      .select({
        actorType: auditLog.actorType,
        action: auditLog.action,
        details: auditLog.details,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantId),
          gte(auditLog.occurredAt, period.start),
          lt(auditLog.occurredAt, period.end),
          or(
            and(
              eq(auditLog.action, "tool.invoked"),
              sql`${auditLog.details}->>'tool' = 'refund.create'`,
              sql`${auditLog.details}->>'ok' = 'true'`,
            ),
            eq(auditLog.action, "ticket.refund_issued"),
          ),
        ),
      ),
    db
      .select({
        failed: sql<number>`count(*) FILTER (WHERE ${replyDeliveries.status} = 'pending' AND ${replyDeliveries.attempts} > 0)::int`,
        abandoned: sql<number>`count(*) FILTER (WHERE ${replyDeliveries.status} = 'abandoned')::int`,
      })
      .from(replyDeliveries)
      .where(
        and(
          eq(replyDeliveries.tenantId, tenantId),
          gte(replyDeliveries.createdAt, period.start),
          lt(replyDeliveries.createdAt, period.end),
        ),
      ),
    db
      .select({
        status: tickets.status,
        count: sql<number>`count(*)::int`,
      })
      .from(tickets)
      .where(
        and(
          eq(tickets.tenantId, tenantId),
          notInArray(tickets.status, ["resolved", "archived"]),
        ),
      )
      .groupBy(tickets.status)
      .orderBy(asc(tickets.status)),
  ]);

  const cohort = cohortRows[0] ?? {
    total: 0,
    resolved: 0,
    merchantTakeovers: 0,
    automaticEscalations: 0,
    handedOff: 0,
    humanHandled: 0,
    agentAssisted: 0,
    unresolved: 0,
    unclassified: 0,
  };
  const drafts = draftRows[0] ?? {
    decided: 0,
    accepted: 0,
    acceptedWithoutEdit: 0,
    editedThenAccepted: 0,
    declined: 0,
  };
  const activity = activityRows[0] ?? {
    ticketsResolved: 0,
    medianResolutionMinutes: null,
  };
  const normalizeMedian = (value: number | null | undefined): number | null =>
    value == null ? null : Math.round(Number(value) * 10) / 10;
  const refundTotals = new Map<string, number>();
  let issuedByAgent = 0;
  let issuedByHuman = 0;
  for (const row of refundRows) {
    if (row.actorType === "agent") issuedByAgent += 1;
    else issuedByHuman += 1;
    const details = row.details as Record<string, unknown>;
    const currency =
      typeof details["currencyCode"] === "string"
        ? details["currencyCode"].toUpperCase()
        : null;
    const minorUnits =
      row.action === "ticket.refund_issued"
        ? typeof details["amount"] === "string" &&
          Number.isFinite(Number(details["amount"]))
          ? Math.round(Number(details["amount"]) * 100)
          : null
        : typeof details["amountMinorUnits"] === "number"
          ? Math.round(details["amountMinorUnits"])
          : null;
    if (currency && minorUnits !== null) {
      refundTotals.set(currency, (refundTotals.get(currency) ?? 0) + minorUnits);
    }
  }
  const delivery = deliveryRows[0] ?? { failed: 0, abandoned: 0 };

  return {
    period: {
      start: period.start.toISOString(),
      end: period.end.toISOString(),
      timezone: "UTC",
    },
    cohort: {
      ticketsCreated: cohort.total,
      resolutionRate: {
        count: cohort.resolved,
        total: cohort.total,
        percentage: analyticsPercentage(cohort.resolved, cohort.total),
      },
      handoffRate: {
        count: cohort.handedOff,
        total: cohort.total,
        percentage: analyticsPercentage(cohort.handedOff, cohort.total),
      },
      handoffs: {
        merchantTakeovers: cohort.merchantTakeovers,
        automaticEscalations: cohort.automaticEscalations,
      },
      resolutionOwnership: {
        agentAssisted: cohort.agentAssisted,
        humanHandled: cohort.humanHandled,
        unresolved: cohort.unresolved,
      },
      topScenarios: scenarioRows.map((row) => ({
        scenarioKey: row.scenarioKey,
        count: row.count,
        percentage: analyticsPercentage(row.count, cohort.total),
      })),
      unclassifiedTickets: cohort.unclassified,
    },
    activity: {
      ticketsResolved: activity.ticketsResolved,
      medianFirstResponseMinutes: normalizeMedian(firstResponseRows[0]?.median),
      medianResolutionMinutes: normalizeMedian(
        activity.medianResolutionMinutes,
      ),
      medianApprovalWaitMinutes: normalizeMedian(approvalWaitRows[0]?.median),
      drafts: {
        decided: drafts.decided,
        accepted: {
          count: drafts.accepted,
          total: drafts.decided,
          percentage: analyticsPercentage(drafts.accepted, drafts.decided),
        },
        acceptedWithoutEdit: drafts.acceptedWithoutEdit,
        acceptedWithoutEditRate: {
          count: drafts.acceptedWithoutEdit,
          total: drafts.decided,
          percentage: analyticsPercentage(
            drafts.acceptedWithoutEdit,
            drafts.decided,
          ),
        },
        editedThenAccepted: drafts.editedThenAccepted,
        editedThenAcceptedRate: {
          count: drafts.editedThenAccepted,
          total: drafts.decided,
          percentage: analyticsPercentage(
            drafts.editedThenAccepted,
            drafts.decided,
          ),
        },
        declined: drafts.declined,
        declinedRate: {
          count: drafts.declined,
          total: drafts.decided,
          percentage: analyticsPercentage(drafts.declined, drafts.decided),
        },
      },
      refunds: {
        total: refundRows.length,
        issuedByAgent,
        issuedByHuman,
        valueByCurrency: [...refundTotals.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([currencyCode, amountMinorUnits]) => ({
            currencyCode,
            amountMinorUnits,
          })),
      },
      customerReplyDeliveries: {
        failed: delivery.failed,
        abandoned: delivery.abandoned,
      },
    },
    backlog: {
      total: backlogRows.reduce((sum, row) => sum + row.count, 0),
      byStatus: backlogRows,
    },
  };
};

export const deliveryAnalytics = async (
  db: DrizzleDb,
  tenantId: string,
  period: { readonly start: Date; readonly end: Date },
): Promise<DeliveryAnalytics> => {
  const cohortAnchor = sql`coalesce(${shipments.shippedAt}, ${shipments.createdAt})`;
  const cohortWhere = and(
    eq(shipments.tenantId, tenantId),
    sql`${cohortAnchor} >= ${period.start.toISOString()}::timestamptz`,
    sql`${cohortAnchor} < ${period.end.toISOString()}::timestamptz`,
  );
  const [cohortRows, carrierRows, activityRows, currentRows] =
    await Promise.all([
      db
        .select({
          total: sql<number>`count(*)::int`,
          delivered: sql<number>`count(*) FILTER (WHERE ${shipments.deliveredAt} IS NOT NULL)::int`,
          exceptions: sql<number>`count(*) FILTER (WHERE ${shipments.firstExceptionAt} IS NOT NULL)::int`,
          recovered: sql<number>`count(*) FILTER (
            WHERE ${shipments.firstExceptionAt} IS NOT NULL
              AND ${shipments.deliveredAt} > ${shipments.firstExceptionAt}
          )::int`,
        })
        .from(shipments)
        .where(cohortWhere),
      db
        .select({
          carrier: sql<string>`coalesce(nullif(${shipments.carrier}, ''), 'Unknown')`,
          shipments: sql<number>`count(*)::int`,
          exceptions: sql<number>`count(*) FILTER (WHERE ${shipments.firstExceptionAt} IS NOT NULL)::int`,
        })
        .from(shipments)
        .where(cohortWhere)
        .groupBy(sql`coalesce(nullif(${shipments.carrier}, ''), 'Unknown')`)
        .orderBy(desc(sql`count(*)`), asc(sql`coalesce(nullif(${shipments.carrier}, ''), 'Unknown')`))
        .limit(10),
      db
        .select({
          delivered: sql<number>`count(*) FILTER (
            WHERE ${shipments.deliveredAt} >= ${period.start.toISOString()}::timestamptz
              AND ${shipments.deliveredAt} < ${period.end.toISOString()}::timestamptz
          )::int`,
          exceptions: sql<number>`count(*) FILTER (
            WHERE ${shipments.firstExceptionAt} >= ${period.start.toISOString()}::timestamptz
              AND ${shipments.firstExceptionAt} < ${period.end.toISOString()}::timestamptz
          )::int`,
          stopped: sql<number>`count(*) FILTER (
            WHERE ${shipments.trackingStoppedAt} >= ${period.start.toISOString()}::timestamptz
              AND ${shipments.trackingStoppedAt} < ${period.end.toISOString()}::timestamptz
          )::int`,
          medianTransitDays: sql<number | null>`
            percentile_cont(0.5) WITHIN GROUP (
              ORDER BY ${shipments.transitDays}
            ) FILTER (
              WHERE ${shipments.deliveredAt} >= ${period.start.toISOString()}::timestamptz
                AND ${shipments.deliveredAt} < ${period.end.toISOString()}::timestamptz
                AND ${shipments.transitDays} IS NOT NULL
            )
          `,
        })
        .from(shipments)
        .where(eq(shipments.tenantId, tenantId)),
      db
        .select({
          total: sql<number>`count(*)::int`,
          inTransit: sql<number>`count(*) FILTER (WHERE ${shipments.status} = 'in_transit')::int`,
          pending: sql<number>`count(*) FILTER (WHERE ${shipments.status} IN ('pending', 'unknown'))::int`,
          exceptions: sql<number>`count(*) FILTER (WHERE ${shipments.status} = 'exception')::int`,
          stopped: sql<number>`count(*) FILTER (WHERE ${shipments.status} = 'stopped')::int`,
          delivered: sql<number>`count(*) FILTER (WHERE ${shipments.status} = 'delivered')::int`,
        })
        .from(shipments)
        .where(eq(shipments.tenantId, tenantId)),
    ]);
  const cohort = cohortRows[0] ?? {
    total: 0,
    delivered: 0,
    exceptions: 0,
    recovered: 0,
  };
  const activity = activityRows[0] ?? {
    delivered: 0,
    exceptions: 0,
    stopped: 0,
    medianTransitDays: null,
  };
  const current = currentRows[0] ?? {
    total: 0,
    inTransit: 0,
    pending: 0,
    exceptions: 0,
    stopped: 0,
    delivered: 0,
  };
  return {
    period: {
      start: period.start.toISOString(),
      end: period.end.toISOString(),
      timezone: "UTC",
    },
    cohort: {
      shipmentsCreated: cohort.total,
      deliveryRate: {
        count: cohort.delivered,
        total: cohort.total,
        percentage: analyticsPercentage(cohort.delivered, cohort.total),
      },
      exceptionRate: {
        count: cohort.exceptions,
        total: cohort.total,
        percentage: analyticsPercentage(cohort.exceptions, cohort.total),
      },
      exceptionRecoveryRate: {
        count: cohort.recovered,
        total: cohort.exceptions,
        percentage: analyticsPercentage(cohort.recovered, cohort.exceptions),
      },
      topCarriers: carrierRows.map((row) => ({
        carrier: row.carrier,
        shipments: row.shipments,
        exceptions: row.exceptions,
        exceptionRate: {
          count: row.exceptions,
          total: row.shipments,
          percentage: analyticsPercentage(row.exceptions, row.shipments),
        },
      })),
    },
    activity: {
      delivered: activity.delivered,
      exceptions: activity.exceptions,
      trackingStopped: activity.stopped,
      medianTransitDays:
        activity.medianTransitDays === null
          ? null
          : Number(activity.medianTransitDays),
    },
    current,
  };
};

// ============================================================
// Tickets
// ============================================================

/** Postgres LIKE/ILIKE wildcards, so a user typing `%` or `_` stays literal. */
const escapeLike = (raw: string): string => raw.replace(/[\\%_]/g, "\\$&");

/** Paginated tickets list for one tenant, newest activity first. */
export const ticketsList = async (
  db: DrizzleDb,
  tenantId: string,
  filter: TicketsFilter,
  requestedPage: number,
  pageSize: number,
): Promise<Page<TicketListRow>> => {
  const whereParts: SQL[] = [eq(tickets.tenantId, tenantId)];
  const q = filter.q?.trim();
  if (q) {
    const term = `%${escapeLike(q)}%`;
    whereParts.push(
      or(
        ilike(tickets.subject, term),
        ilike(tickets.summary, term),
        ilike(sql`${tickets.context}->>'scenarioKey'`, term),
        // Customer identity, stamped on the ticket context.
        ilike(sql`${tickets.context}->>'customerEmail'`, term),
        ilike(sql`${tickets.context}->>'customerName'`, term),
        // Order references. `shopify_order_id` holds the RESOLVED id and is
        // often set on only one thread of an order, so searching an order
        // number there returns a single ticket. `quotedOrderRef` is the number
        // the customer wrote — stamped per thread — so matching it surfaces
        // EVERY email thread tied to that order. `identifiedOrderId` lets a
        // pasted GID match too.
        ilike(sql`${tickets.context}->>'quotedOrderRef'`, term),
        ilike(sql`${tickets.context}->>'identifiedOrderId'`, term),
        ilike(tickets.shopifyOrderId, term),
      )!,
    );
  }
  if (filter.status?.length) {
    whereParts.push(inArray(tickets.status, [...filter.status]));
  } else {
    // Archiving is a soft delete: archived tickets surface only when the
    // status filter asks for them explicitly.
    whereParts.push(ne(tickets.status, "archived"));
  }
  if (filter.excludeStatus?.length) {
    whereParts.push(notInArray(tickets.status, [...filter.excludeStatus]));
  }
  const whereExpr = and(...whereParts);

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tickets)
    .where(whereExpr);
  const totalRows = countRow?.count ?? 0;
  const page = clampPage(requestedPage, totalRows, pageSize);
  const rows = await db
    .select({
      id: tickets.id,
      subject: tickets.subject,
      status: tickets.status,
      scenarioKey: sql<string | null>`${tickets.context}->>'scenarioKey'`,
      currentAgentId: tickets.currentAgentId,
      priority: tickets.priority,
      // The order the ticket is about, from the SAME single source of truth the
      // ticket page + refund use — `context` — not the legacy `shopify_order_id`
      // column (which the runtime stopped maintaining once `identifiedOrderId`
      // became canonical, and which a manual "assign order" edit doesn't touch).
      // Prefer the human-friendly ref the customer/merchant wrote
      // (`quotedOrderRef`, e.g. "#1001") over the canonical GID, and keep the
      // legacy column as a last-resort fallback for old rows. `formatOrderRef`
      // normalizes whichever wins.
      orderRef: sql<string | null>`coalesce(
        ${tickets.context}->>'quotedOrderRef',
        ${tickets.context}->>'identifiedOrderId',
        ${tickets.shopifyOrderId}
      )`,
      preview: tickets.summary,
      // Requester email lives in the agent-stamped context JSONB (same row —
      // no join). NULL when the ticket has no customer email yet.
      customerEmail: sql<
        string | null
      >`${tickets.context}->>'customerEmail'`,
      createdAt: tickets.createdAt,
      updatedAt: tickets.updatedAt,
      // Concurrent wait facts, row-derived via correlated EXISTS (no join,
      // no N+1 — approvals_ticket_idx / cse_ticket_idx cover both). `exists()`
      // qualifies the correlated columns (`"approvals"."ticket_id" =
      // "tickets"."id"`); a hand-rolled sql`EXISTS(...)` does NOT and silently
      // compares the wrong columns. A ticket parked `waiting_for_approval` can
      // also carry an open escalation.
      waitingApproval: exists(
        db
          .select({ one: sql`1` })
          .from(approvals)
          .where(
            and(
              eq(approvals.ticketId, tickets.id),
              eq(approvals.tenantId, tickets.tenantId),
              eq(approvals.status, "pending"),
            ),
          ),
      ),
      waitingFulfillmentOperator: exists(
        db
          .select({ one: sql`1` })
          .from(ticketFulfillmentOperatorEscalations)
          .where(
            and(
              eq(ticketFulfillmentOperatorEscalations.ticketId, tickets.id),
              eq(ticketFulfillmentOperatorEscalations.tenantId, tickets.tenantId),
              eq(ticketFulfillmentOperatorEscalations.status, "open"),
            ),
          ),
      ),
    })
    .from(tickets)
    .where(whereExpr)
    .orderBy(desc(tickets.updatedAt), desc(tickets.id))
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
      scenarioKey: r.scenarioKey,
      currentAgentId: r.currentAgentId,
      priority: r.priority,
      orderRef: r.orderRef,
      preview: r.preview,
      customerEmail: r.customerEmail,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      waitingOn: {
        approval: Boolean(r.waitingApproval),
        fulfillmentOperator: Boolean(r.waitingFulfillmentOperator),
      },
    })),
  };
};

const toApprovalDetail = (a: typeof approvals.$inferSelect): ApprovalDetail => ({
  id: a.id,
  ticketId: a.ticketId,
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

// A short one-line preview of a conversation.reply approval's drafted body,
// for the "approved but not sent" card. proposedInput is unknown at the type
// level (it's the tool's stored input) — pull bodyText defensively.
const replyBodyPreview = (proposedInput: unknown): string => {
  const body =
    proposedInput &&
    typeof proposedInput === "object" &&
    "bodyText" in proposedInput
      ? (proposedInput as { readonly bodyText?: unknown }).bodyText
      : null;
  const text = typeof body === "string" ? body.replace(/\s+/g, " ").trim() : "";
  return text.length > 140 ? `${text.slice(0, 139)}…` : text;
};

const toAuditEntry = (e: typeof auditLog.$inferSelect): AuditEntry => ({
  id: e.id.toString(),
  ticketId: e.ticketId,
  action: e.action,
  actorType: e.actorType,
  actorId: e.actorId,
  occurredAt: e.occurredAt.toISOString(),
  details: e.details,
});

/**
 * Full ticket detail: the ticket row, its complete audit timeline (ascending),
 * and its approvals. Returns null when the ticket isn't in the tenant (the
 * endpoint maps that to 404 — disclosure-safe). Shopify customer/order
 * panels are fetched via separate connector endpoints, not here.
 */
export const ticketDetail = async (
  db: DrizzleDb,
  tenantId: string,
  ticketId: string,
): Promise<TicketDetail | null> => {
  const [row] = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.id, ticketId), eq(tickets.tenantId, tenantId)))
    .limit(1);
  if (!row) return null;

  const [entries, ticketApprovals, activeReplyDelivery] = await Promise.all([
    db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ticketId, ticketId), eq(auditLog.tenantId, tenantId)))
      .orderBy(asc(auditLog.id)),
    db
      .select()
      .from(approvals)
      .where(and(eq(approvals.ticketId, ticketId), eq(approvals.tenantId, tenantId)))
      .orderBy(asc(approvals.createdAt)),
    getActiveReplyDeliveryForTicket(db, ticketId),
  ]);

  const auditEntries = entries.map(toAuditEntry);
  const approvalDetails = ticketApprovals.map(toApprovalDetail);
  const resurfaceable = resurfaceableApprovedReply(auditEntries, approvalDetails);

  // Concurrent wait facts: approval derived from the rows we already loaded;
  // fulfillmentOperator is one indexed lookup (cse_ticket_idx). A ticket parked
  // `waiting_for_approval` can also carry an open escalation.
  const waitingOn = {
    approval: approvalDetails.some((a) => a.status === "pending"),
    fulfillmentOperator: await hasOpenEscalationForTicket(db, tenantId, ticketId),
  };
  const scenarioKey = (row.context as Record<string, unknown>)["scenarioKey"];

  return {
    ticket: {
      id: row.id,
      subject: row.subject,
      status: row.status,
      scenarioKey: typeof scenarioKey === "string" ? scenarioKey : null,
      currentAgentId: row.currentAgentId,
      priority: row.priority,
      summary: row.summary,
      context: row.context,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
      manualStatusTargets: allowedManualStatusTargets(row.status as TicketStatus),
      waitingOn,
    },
    auditEntries,
    approvals: approvalDetails,
    activeReplyDelivery: toTicketDetailReplyDelivery(activeReplyDelivery),
    approvedNotSent: resurfaceable
      ? {
          approvalId: resurfaceable.id,
          bodyPreview: replyBodyPreview(resurfaceable.proposedInput),
          occurredAt: resurfaceable.decidedAt ?? resurfaceable.createdAt,
        }
      : null,
  };
};

/**
 * Audit rows for a ticket with id > `sinceId`, ascending (poll replacement for
 * the old SSE route). Returns null when the ticket isn't in the tenant (404).
 */
export const ticketEvents = async (
  db: DrizzleDb,
  tenantId: string,
  ticketId: string,
  sinceId: bigint,
): Promise<TicketEventsResult | null> => {
  const [ticketRow] = await db
    .select({ id: tickets.id })
    .from(tickets)
    .where(and(eq(tickets.id, ticketId), eq(tickets.tenantId, tenantId)))
    .limit(1);
  if (!ticketRow) return null;

  const rows = await db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      actorType: auditLog.actorType,
      actorId: auditLog.actorId,
      occurredAt: auditLog.occurredAt,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.ticketId, ticketId),
        // Redundant with the ticketId pre-check above, but every sibling query
        // double-scopes by tenant — keep the invariant uniform (audit D12).
        eq(auditLog.tenantId, tenantId),
        gt(auditLog.id, sinceId),
      ),
    )
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
  // Absent/empty status defaults to pending (the actionable landing view).
  const status = filter.status?.length ? filter.status : ["pending"];
  const whereParts: SQL[] = [eq(approvals.tenantId, tenantId)];
  whereParts.push(inArray(approvals.status, [...status]));
  if (filter.risk?.length)
    whereParts.push(inArray(approvals.riskLevel, [...filter.risk]));
  if (filter.tool?.length)
    whereParts.push(inArray(approvals.tool, [...filter.tool]));
  if (filter.agent?.length)
    whereParts.push(inArray(approvals.agentId, [...filter.agent]));
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
      ticketId: approvals.ticketId,
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
      ticketId: r.ticketId,
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
// Connector connections (integrations pages + ticket-detail shop domain)
// ============================================================

/**
 * All connector connections for a tenant (newest install first). Backs the
 * integrations overview + per-provider pages, and the ticket-detail Shopify
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
 * The agent-stamped `context` for a ticket (tenant-scoped). Null when the ticket
 * isn't in the tenant. Backs the ticket-detail Shopify panels, which read
 * `identifiedOrderId` / `shopifyCustomerId` / `customerEmail` from it.
 */
export const ticketContextForTenant = async (
  db: DrizzleDb,
  tenantId: string,
  ticketId: string,
): Promise<{ readonly context: unknown } | null> => {
  const [row] = await db
    .select({ context: tickets.context })
    .from(tickets)
    .where(and(eq(tickets.id, ticketId), eq(tickets.tenantId, tenantId)))
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
      systemPrompt: tenantAgentOverrides.systemPrompt,
      toolPermissions: tenantAgentOverrides.toolPermissions,
    })
    .from(tenantAgentOverrides)
    .where(eq(tenantAgentOverrides.tenantId, tenantId));
  return rows.map((r) => ({
    agentId: r.agentId,
    model: r.model,
    systemPrompt: r.systemPrompt,
    toolPermissions: r.toolPermissions,
  }));
};

/**
 * Knowledge-base document summaries for settings/knowledge (no `content` — the
 * list view doesn't need the potentially-large body; the editor fetches one
 * full doc via the service-backed GET). Oldest first (creation order).
 */
export const knowledgeDocuments = async (
  db: DrizzleDb,
  tenantId: string,
): Promise<ReadonlyArray<KnowledgeDocumentSummaryView>> => {
  const rows = await db
    .select({
      id: tenantKnowledgeDocuments.id,
      title: tenantKnowledgeDocuments.title,
      sourceType: tenantKnowledgeDocuments.sourceType,
      sourceUrl: tenantKnowledgeDocuments.sourceUrl,
      fetchedAt: tenantKnowledgeDocuments.fetchedAt,
      createdAt: tenantKnowledgeDocuments.createdAt,
      updatedAt: tenantKnowledgeDocuments.updatedAt,
    })
    .from(tenantKnowledgeDocuments)
    .where(eq(tenantKnowledgeDocuments.tenantId, tenantId))
    .orderBy(asc(tenantKnowledgeDocuments.createdAt));
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    sourceType: r.sourceType as KnowledgeSourceType,
    sourceUrl: r.sourceUrl,
    fetchedAt: r.fetchedAt ? r.fetchedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
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
