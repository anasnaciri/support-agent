import Link from "next/link";
import { desc, and, eq } from "drizzle-orm";
import { approvals } from "@support-agent/db";
import { db } from "@/lib/db";
import { getTenantId } from "@/lib/tenant";

interface SearchParams {
  readonly searchParams: Promise<{
    readonly decided?: string;
    readonly action?: string;
    readonly kind?: string;
  }>;
}

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
    return {
      tone: "warn",
      text: "Approval not found.",
    };
  }
  return null;
};

export default async function ApprovalsPage({ searchParams }: SearchParams) {
  const tenantId = await getTenantId();
  const sp = await searchParams;
  const banner = bannerFor(sp);
  const rows = await db()
    .select({
      id: approvals.id,
      caseId: approvals.caseId,
      agentId: approvals.agentId,
      tool: approvals.tool,
      riskLevel: approvals.riskLevel,
      createdAt: approvals.createdAt,
      expiresAt: approvals.expiresAt,
    })
    .from(approvals)
    .where(
      and(
        eq(approvals.tenantId, tenantId),
        eq(approvals.status, "pending"),
      ),
    )
    .orderBy(desc(approvals.createdAt))
    .limit(100);

  return (
    <>
      {banner ? (
        <div className={`banner ${banner.tone}`}>{banner.text}</div>
      ) : null}
      <h1>Pending approvals</h1>
      <p className="muted">{rows.length} waiting on a decision.</p>
      <table>
        <thead>
          <tr>
            <th>Tool</th>
            <th>Risk</th>
            <th>Agent</th>
            <th>Case</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <Link href={`/approvals/${r.id}`}>{r.tool}</Link>
              </td>
              <td>
                <span className={`badge ${r.riskLevel}`}>{r.riskLevel}</span>
              </td>
              <td>{r.agentId}</td>
              <td>
                <Link href={`/cases/${r.caseId}`}>{r.caseId.slice(0, 8)}…</Link>
              </td>
              <td>{r.createdAt.toISOString().slice(0, 16).replace("T", " ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
