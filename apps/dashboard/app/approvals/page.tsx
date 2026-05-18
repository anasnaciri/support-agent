import Link from "next/link";
import { desc, and, eq, sql, type SQL } from "drizzle-orm";
import { approvals } from "@support-agent/db";
import { db } from "@/lib/db";
import { getTenantId } from "@/lib/tenant";
import { formatRelativeTime } from "@/lib/format";

interface SearchParams {
  readonly searchParams: Promise<{
    readonly decided?: string;
    readonly action?: string;
    readonly kind?: string;
    readonly status?: string;
    readonly risk?: string;
    readonly tool?: string;
    readonly agent?: string;
  }>;
}

const STATUS_FILTERS = [
  { label: "Pending", value: "pending" },
  { label: "Approved", value: "approved" },
  { label: "Rejected", value: "rejected" },
  { label: "Any status", value: "any" },
] as const;

const RISK_FILTERS = [
  { label: "Any risk", value: "" },
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
  { label: "Critical", value: "critical" },
] as const;

const bannerFor = (
  params: { decided?: string; action?: string; kind?: string },
): { readonly tone: "success" | "info" | "warn"; readonly text: string } | null => {
  if (!params.decided) return null;
  const isApprove = params.action === "approve";
  if (params.kind === "decided") {
    return {
      tone: "success",
      text: isApprove
        ? "Approved. The customer reply will be sent in a moment."
        : "Rejected. The case is now in human takeover.",
    };
  }
  if (params.kind === "already_decided") {
    return {
      tone: "info",
      text: "This approval had already been decided — no change.",
    };
  }
  if (params.kind === "approval_not_found") {
    return { tone: "warn", text: "Approval not found." };
  }
  return null;
};

export default async function ApprovalsPage({ searchParams }: SearchParams) {
  const tenantId = await getTenantId();
  const sp = await searchParams;
  const banner = bannerFor(sp);

  const statusFilter = sp.status ?? "pending";
  const riskFilter = sp.risk ?? "";
  const toolFilter = sp.tool ?? "";
  const agentFilter = sp.agent ?? "";

  const whereParts: SQL[] = [eq(approvals.tenantId, tenantId)];
  if (statusFilter !== "any") {
    whereParts.push(eq(approvals.status, statusFilter));
  }
  if (riskFilter) whereParts.push(eq(approvals.riskLevel, riskFilter));
  if (toolFilter) whereParts.push(eq(approvals.tool, toolFilter));
  if (agentFilter) whereParts.push(eq(approvals.agentId, agentFilter));

  // Distinct tool + agent values for the dropdowns. Scoped to the
  // tenant so a tenant only sees their own activity. Cheap query on
  // small tables — we cap at the most-recent 100 per facet to avoid
  // pulling the entire history if the table grows.
  const [toolFacets, agentFacets, rows] = await Promise.all([
    db()
      .selectDistinct({ tool: approvals.tool })
      .from(approvals)
      .where(eq(approvals.tenantId, tenantId))
      .orderBy(approvals.tool),
    db()
      .selectDistinct({ agentId: approvals.agentId })
      .from(approvals)
      .where(eq(approvals.tenantId, tenantId))
      .orderBy(approvals.agentId),
    db()
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
      .where(and(...whereParts))
      .orderBy(desc(approvals.createdAt))
      .limit(100),
  ]);

  // Count summary for the headline. Run as a single grouped count so
  // we don't fan out four separate queries.
  const counts = await db()
    .select({
      status: approvals.status,
      count: sql<number>`count(*)::int`,
    })
    .from(approvals)
    .where(eq(approvals.tenantId, tenantId))
    .groupBy(approvals.status);

  const countOf = (s: string): number =>
    counts.find((c) => c.status === s)?.count ?? 0;

  return (
    <>
      {banner ? (
        <div className={`banner ${banner.tone}`}>{banner.text}</div>
      ) : null}
      <h1>Approvals</h1>
      <p className="muted">
        <strong>{countOf("pending")}</strong> pending ·{" "}
        <strong>{countOf("approved")}</strong> approved ·{" "}
        <strong>{countOf("rejected")}</strong> rejected
      </p>

      <form method="get" className="filter-bar">
        <label>
          Status
          <select name="status" defaultValue={statusFilter}>
            {STATUS_FILTERS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Risk
          <select name="risk" defaultValue={riskFilter}>
            {RISK_FILTERS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Tool
          <select name="tool" defaultValue={toolFilter}>
            <option value="">Any tool</option>
            {toolFacets.map((f) => (
              <option key={f.tool} value={f.tool}>
                {f.tool}
              </option>
            ))}
          </select>
        </label>
        <label>
          Agent
          <select name="agent" defaultValue={agentFilter}>
            <option value="">Any agent</option>
            {agentFacets.map((f) => (
              <option key={f.agentId} value={f.agentId}>
                {f.agentId}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn btn-primary">
          Apply
        </button>
        {riskFilter || toolFilter || agentFilter || statusFilter !== "pending" ? (
          <Link href="/approvals" className="muted">
            Reset
          </Link>
        ) : null}
      </form>

      <p className="muted">
        Showing {rows.length} of{" "}
        {statusFilter === "any" ? "any status" : statusFilter}.
      </p>

      <table>
        <thead>
          <tr>
            <th>Tool</th>
            <th>Status</th>
            <th>Risk</th>
            <th>Agent</th>
            <th>Case</th>
            <th>Created</th>
            <th>Decided</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={7} className="muted" style={{ textAlign: "center" }}>
                No approvals match these filters.
              </td>
            </tr>
          ) : null}
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <Link href={`/approvals/${r.id}`}>{r.tool}</Link>
              </td>
              <td>
                <span className={`badge ${r.status}`}>{r.status}</span>
              </td>
              <td>
                <span className={`badge ${r.riskLevel}`}>{r.riskLevel}</span>
              </td>
              <td>{r.agentId}</td>
              <td>
                <Link href={`/cases/${r.caseId}`}>{r.caseId.slice(0, 8)}…</Link>
              </td>
              <td>{formatRelativeTime(r.createdAt)}</td>
              <td>
                {r.decidedAt ? formatRelativeTime(r.decidedAt) : (
                  <span className="muted">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
