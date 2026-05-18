import type { ApprovalRow } from "@support-agent/db";
import { formatRelativeTime } from "@/lib/format";
import { approveAction, rejectAction } from "../../approvals/[id]/actions";

interface Props {
  readonly approval: ApprovalRow;
  readonly returnTo: string;
}

// Inline approval surface on the case detail page. Master-plan §13's
// case-detail mock places the approve/reject buttons inline so the
// operator doesn't have to navigate away from the timeline + Customer
// + Order context they came here to see.
//
// We reuse the /approvals/[id] server actions verbatim — they now
// honor a `returnTo` form field so the redirect bounces back to the
// case (with the decided=/action=/kind= banner params) rather than
// the approvals list. The action is also unchanged when invoked from
// the original detail page; `returnTo` is opt-in.

export const ApprovalCard = ({ approval, returnTo }: Props) => {
  const proposed =
    approval.proposedInput && typeof approval.proposedInput === "object"
      ? (approval.proposedInput as Record<string, unknown>)
      : null;
  const editableBodyText =
    proposed && typeof proposed["bodyText"] === "string"
      ? (proposed["bodyText"] as string)
      : null;

  return (
    <div className="approval-card">
      <div className="approval-card-header">
        <div>
          <div className="approval-card-title">
            Awaiting approval
            <span className={`badge perm-ask`}>{approval.tool}</span>
          </div>
          <div className="muted">
            {approval.agentId} · risk: {approval.riskLevel} ·{" "}
            {formatRelativeTime(approval.createdAt)}
          </div>
        </div>
      </div>

      {approval.reasoning ? (
        <p style={{ margin: "8px 0" }}>{approval.reasoning}</p>
      ) : null}

      {editableBodyText !== null ? (
        <form action={approveAction} className="edit-and-approve">
          <input type="hidden" name="approvalId" value={approval.id} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <label>
            Reply body (edit before approving)
            <textarea
              name="bodyText"
              defaultValue={editableBodyText}
              rows={6}
            />
          </label>
          <div className="approval-actions">
            <button type="submit" className="btn btn-approve">
              Approve & send
            </button>
            <a
              href={`/approvals/${approval.id}`}
              className="btn btn-secondary"
            >
              Open full view
            </a>
          </div>
        </form>
      ) : (
        <>
          <details style={{ margin: "8px 0" }}>
            <summary className="muted">Proposed input</summary>
            <pre
              style={{
                background: "#fafafa",
                padding: 12,
                borderRadius: 6,
                fontSize: 13,
                overflow: "auto",
                marginTop: 8,
              }}
            >
              {JSON.stringify(approval.proposedInput, null, 2)}
            </pre>
          </details>
          <form action={approveAction}>
            <input type="hidden" name="approvalId" value={approval.id} />
            <input type="hidden" name="returnTo" value={returnTo} />
            <div className="approval-actions">
              <button type="submit" className="btn btn-approve">
                Approve
              </button>
              <a
                href={`/approvals/${approval.id}`}
                className="btn btn-secondary"
              >
                Open full view
              </a>
            </div>
          </form>
        </>
      )}

      <form
        action={rejectAction}
        style={{ marginTop: 12 }}
        className="approval-reject-form"
      >
        <input type="hidden" name="approvalId" value={approval.id} />
        <input type="hidden" name="returnTo" value={returnTo} />
        <button type="submit" className="btn btn-reject">
          Reject (escalate to human takeover)
        </button>
      </form>
    </div>
  );
};
