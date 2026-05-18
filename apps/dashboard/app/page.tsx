import Link from "next/link";
import { sql, eq, and } from "drizzle-orm";
import { cases, approvals } from "@support-agent/db";
import { db } from "@/lib/db";
import { getTenantId } from "@/lib/tenant";

// Counts come straight from Drizzle in a Server Component. Every query
// is scoped to the signed-in user's tenant via `getTenantId()` — a
// missing org / unmapped tenant throws `NoTenantAccess` which the
// route-level error.tsx redirects to /no-access.
export default async function TodayPage() {
  const d = db();
  const tenantId = await getTenantId();
  const [byStatus, pendingApprovals] = await Promise.all([
    d
      .select({
        status: cases.status,
        count: sql<number>`count(*)::int`,
      })
      .from(cases)
      .where(eq(cases.tenantId, tenantId))
      .groupBy(cases.status),
    d
      .select({ count: sql<number>`count(*)::int` })
      .from(approvals)
      .where(
        and(
          eq(approvals.tenantId, tenantId),
          eq(approvals.status, "pending"),
        ),
      ),
  ]);

  const countOf = (status: string): number =>
    byStatus.find((r) => r.status === status)?.count ?? 0;

  const pending = pendingApprovals[0]?.count ?? 0;

  return (
    <>
      <h1>Today</h1>
      <p className="muted">What does the AI need from you?</p>

      <div className="stat-grid">
        <Link href="/approvals" className="stat">
          <div className="label">Need approval</div>
          <div className="value">{pending}</div>
        </Link>
        <div className="stat">
          <div className="label">In progress</div>
          <div className="value">{countOf("in_progress") + countOf("new")}</div>
        </div>
        <div className="stat">
          <div className="label">Waiting for customer</div>
          <div className="value">{countOf("waiting_for_customer")}</div>
        </div>
        <div className="stat">
          <div className="label">Waiting for supplier</div>
          <div className="value">{countOf("waiting_for_supplier")}</div>
        </div>
        <div className="stat">
          <div className="label">Human takeover</div>
          <div className="value">{countOf("human_takeover")}</div>
        </div>
        <div className="stat">
          <div className="label">Resolved (all-time)</div>
          <div className="value">{countOf("resolved")}</div>
        </div>
      </div>
    </>
  );
}
