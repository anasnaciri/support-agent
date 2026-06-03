import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { DrizzleDb } from "./client.js";
import { approvals, cases, tenants } from "./schema.js";

// Read queries backing the dashboard's HTTP API (Path B). The dashboard
// hosts on Cloudflare Workers and can't open a Postgres TCP pool, so these
// flat reads live here (where drizzle is a runtime dep) and are exposed by
// apps/api endpoints rather than run in the dashboard's Server Components.

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
