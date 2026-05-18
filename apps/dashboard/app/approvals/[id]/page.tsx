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
  // Edit-and-Approve only makes sense when there's a bodyText to edit
  // — conversation.reply / conversation.ask_customer today, future
  // text-bearing tools tomorrow. Other tools fall back to read-only
  // JSON + a plain Approve button (the JSON edit UX is a future slice).
  const proposed =
    row.proposedInput && typeof row.proposedInput === "object"
      ? (row.proposedInput as Record<string, unknown>)
      : null;
  const editableBodyText =
    proposed && typeof proposed["bodyText"] === "string"
      ? (proposed["bodyText"] as string)
      : null;

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
          <>
            {editableBodyText !== null ? (
              <form action={approveAction} className="edit-and-approve">
                <input type="hidden" name="approvalId" value={row.id} />
                <label>
                  Reply body (edit before approving)
                  <textarea
                    name="bodyText"
                    defaultValue={editableBodyText}
                    rows={8}
                  />
                </label>
                <div className="approval-actions">
                  <button type="submit" className="btn btn-approve">
                    Approve
                  </button>
                </div>
                <p className="muted" style={{ marginTop: 4, fontSize: 12 }}>
                  Your edits land in <code>approvedInput</code>; the runtime
                  resume sends exactly this text to the customer.
                </p>
              </form>
            ) : (
              <form action={approveAction}>
                <input type="hidden" name="approvalId" value={row.id} />
                <div className="approval-actions">
                  <button type="submit" className="btn btn-approve">
                    Approve
                  </button>
                </div>
              </form>
            )}

            <form action={rejectAction} style={{ marginTop: 12 }}>
              <input type="hidden" name="approvalId" value={row.id} />
              <button type="submit" className="btn btn-reject">
                Reject
              </button>
            </form>

            <p className="muted" style={{ marginTop: 16 }}>
              Approving sends the (possibly edited) reply to the customer
              through the tenant's configured connector. Rejecting
              escalates the case to human takeover; no customer reply
              goes out.
            </p>
          </>
        ) : (
          <p className="muted">
            Decided{" "}
            {row.decidedAt
              ? row.decidedAt.toISOString().slice(0, 19).replace("T", " ")
              : "(no timestamp)"}
            {row.decidedBy ? ` by ${row.decidedBy}` : ""}.
            {row.approvedInput &&
            typeof row.approvedInput === "object" &&
            "bodyText" in (row.approvedInput as Record<string, unknown>) ? (
              <>
                {" "}
                Manager edited the body text before approving.
              </>
            ) : null}
          </p>
        )}
      </div>
    </>
  );
}
