import Link from "next/link";
import { sql, eq, and, gte, desc } from "drizzle-orm";
import { approvals, cases } from "@support-agent/db";
import { db } from "@/lib/db";
import { getTenantId } from "@/lib/tenant";
import { formatRelativeTime } from "@/lib/format";

// Master-plan §13 IA: the manager's daily home. The first thing they
// should see is "what does the AI need from me?" — pending approvals
// + human-takeover queue, with the actual cases listed, not just
// counts. Smaller stat strip for the other states below.

const TOP_N = 5;

interface TodaySearchParams {
  readonly searchParams?: Promise<{ readonly onboarded?: string }>;
}

export default async function TodayPage({ searchParams }: TodaySearchParams) {
  const sp = searchParams ? await searchParams : {};
  const justOnboarded = sp.onboarded === "1";
  const d = db();
  const tenantId = await getTenantId();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [byStatus, pendingApprovals, takeoverCases, resolvedToday] =
    await Promise.all([
      // Status counts for the slim strip below the prominent cards.
      d
        .select({
          status: cases.status,
          count: sql<number>`count(*)::int`,
        })
        .from(cases)
        .where(eq(cases.tenantId, tenantId))
        .groupBy(cases.status),
      // Top-N pending approvals — newest-first so urgent stuff stays
      // visible. We surface tool + agent + age in the list itself.
      d
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
          and(
            eq(approvals.tenantId, tenantId),
            eq(approvals.status, "pending"),
          ),
        )
        .orderBy(desc(approvals.createdAt))
        .limit(TOP_N),
      // Cases sitting in human_takeover — the manager has to do
      // something here that the agent can't.
      d
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
      // Today's resolved count for the headline summary.
      d
        .select({ count: sql<number>`count(*)::int` })
        .from(cases)
        .where(
          and(
            eq(cases.tenantId, tenantId),
            eq(cases.status, "resolved"),
            gte(cases.resolvedAt, todayStart),
          ),
        ),
    ]);

  const countOf = (status: string): number =>
    byStatus.find((r) => r.status === status)?.count ?? 0;

  const pendingCount = pendingApprovals.length;
  const takeoverCount = takeoverCases.length;
  const inProgress = countOf("new") + countOf("in_progress") + countOf("triaging");
  const waitingCustomer = countOf("waiting_for_customer");
  const waitingSupplier = countOf("waiting_for_supplier");
  const waitingApproval = countOf("waiting_for_approval");
  const resolvedTodayCount = resolvedToday[0]?.count ?? 0;

  return (
    <>
      {justOnboarded ? (
        <div className="banner success">
          Tenant created. Connect Shopify or Gmail from{" "}
          <a href="/settings/integrations">Settings → Integrations</a>{" "}
          to start receiving cases.
        </div>
      ) : null}
      <h1>Today</h1>
      <p className="summary">
        AI handled <strong>{resolvedTodayCount}</strong> ticket
        {resolvedTodayCount === 1 ? "" : "s"} today ·{" "}
        <strong>{inProgress}</strong> in progress ·{" "}
        <strong>{waitingApproval}</strong> waiting for approval ·{" "}
        <strong>{takeoverCount}</strong> need human takeover
      </p>

      {/* Prominent section: pending approvals. Master plan §13 calls
          this out as the most important screen — leave it at the top
          even when empty so the operator knows where to look. */}
      <section className="section">
        <div className="section-header warn">
          <h2>Need your approval</h2>
          <span className="count">{waitingApproval}</span>
        </div>
        {pendingApprovals.length === 0 ? (
          <p className="section-empty">
            Nothing pending. The agent's drafts will appear here.
          </p>
        ) : (
          <ul className="section-list">
            {pendingApprovals.map((a) => (
              <li key={a.id}>
                <div>
                  <Link href={`/approvals/${a.id}`}>
                    <code>{a.tool}</code>
                  </Link>
                  <div className="meta">
                    {a.agentId} ·{" "}
                    <Link href={`/cases/${a.caseId}`}>
                      case {a.caseId.slice(0, 8)}…
                    </Link>
                  </div>
                </div>
                <div className="age">{formatRelativeTime(a.createdAt)}</div>
              </li>
            ))}
          </ul>
        )}
        {pendingCount > 0 ? (
          <div className="section-footer">
            <Link href="/approvals">View all {waitingApproval} →</Link>
          </div>
        ) : null}
      </section>

      {/* Human takeover — the AI gave up or a manager already took it
          over. Either way, no agent action is happening; humans only. */}
      <section className="section">
        <div className="section-header danger">
          <h2>Need human takeover</h2>
          <span className="count">{takeoverCount}</span>
        </div>
        {takeoverCases.length === 0 ? (
          <p className="section-empty">
            Nothing escalated. Cases that need a human will appear here.
          </p>
        ) : (
          <ul className="section-list">
            {takeoverCases.map((c) => (
              <li key={c.id}>
                <div>
                  <Link href={`/cases/${c.id}`}>
                    {c.subject ?? "(no subject)"}
                  </Link>
                  <div className="meta">{c.category ?? "uncategorized"}</div>
                </div>
                <div className="age">{formatRelativeTime(c.updatedAt)}</div>
              </li>
            ))}
          </ul>
        )}
        {takeoverCount >= TOP_N ? (
          <div className="section-footer">
            <Link href="/cases">View all cases →</Link>
          </div>
        ) : null}
      </section>

      {/* Background queues — fewer eyeballs needed, smaller treatment. */}
      <div className="stat-grid">
        <div className="stat">
          <div className="label">Waiting for customer</div>
          <div className="value">{waitingCustomer}</div>
        </div>
        <div className="stat">
          <div className="label">Waiting for supplier</div>
          <div className="value">{waitingSupplier}</div>
        </div>
        <div className="stat">
          <div className="label">In progress</div>
          <div className="value">{inProgress}</div>
        </div>
        <div className="stat">
          <div className="label">Resolved (all-time)</div>
          <div className="value">{countOf("resolved")}</div>
        </div>
      </div>
    </>
  );
}
