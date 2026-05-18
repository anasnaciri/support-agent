import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { approvals } from "@support-agent/db";
import { db } from "@/lib/db";
import { getTenantId } from "@/lib/tenant";
import { approveAction, rejectAction } from "./actions";

interface Params {
  readonly params: Promise<{ readonly id: string }>;
}

export default async function ApprovalDetailPage({ params }: Params) {
  const { id } = await params;
  const tenantId = await getTenantId();
  const [row] = await db()
    .select()
    .from(approvals)
    .where(and(eq(approvals.id, id), eq(approvals.tenantId, tenantId)))
    .limit(1);
  if (!row) notFound();
  const isPending = row.status === "pending";

  return (
    <>
      <h1>Approval · {row.tool}</h1>
      <p className="muted">
        <span className={`badge ${row.status}`}>{row.status}</span>
        {" · "}
        risk: {row.riskLevel}
        {" · "}
        agent: {row.agentId}
        {" · "}
        case: <a href={`/cases/${row.caseId}`}>{row.caseId.slice(0, 8)}…</a>
      </p>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Reasoning</h2>
        <p>{row.reasoning || <span className="muted">(no reasoning recorded)</span>}</p>

        <h2>Proposed input</h2>
        <pre
          style={{
            background: "#fafafa",
            padding: 12,
            borderRadius: 6,
            fontSize: 13,
            overflow: "auto",
          }}
        >
          {JSON.stringify(row.proposedInput, null, 2)}
        </pre>

        {isPending ? (
          <div className="approval-actions">
            <form action={approveAction}>
              <input type="hidden" name="approvalId" value={row.id} />
              <button type="submit" className="btn btn-approve">
                Approve
              </button>
            </form>
            <form action={rejectAction}>
              <input type="hidden" name="approvalId" value={row.id} />
              <button type="submit" className="btn btn-reject">
                Reject
              </button>
            </form>
            <p className="muted" style={{ marginTop: 16 }}>
              Approving sends the drafted reply to the customer through the
              tenant's configured connector. Rejecting escalates the case
              to human takeover; no customer reply goes out.
            </p>
          </div>
        ) : (
          <p className="muted">
            Decided{" "}
            {row.decidedAt
              ? row.decidedAt.toISOString().slice(0, 19).replace("T", " ")
              : "(no timestamp)"}
            {row.decidedBy ? ` by ${row.decidedBy}` : ""}.
          </p>
        )}
      </div>
    </>
  );
}
