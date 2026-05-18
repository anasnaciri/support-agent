import { notFound } from "next/navigation";
import { asc, and, eq } from "drizzle-orm";
import { cases, auditLog } from "@support-agent/db";
import { db } from "@/lib/db";
import { getTenantId } from "@/lib/tenant";
import CaseLiveBoundary from "./CaseLiveBoundary";

interface Params {
  readonly params: Promise<{ readonly id: string }>;
}

export default async function CaseDetailPage({ params }: Params) {
  const { id } = await params;
  const d = db();
  const tenantId = await getTenantId();
  // Cross-tenant access shows as a 404, not 403. We don't want to
  // disclose whether a case id exists in another tenant.
  const [caseRow] = await d
    .select()
    .from(cases)
    .where(and(eq(cases.id, id), eq(cases.tenantId, tenantId)))
    .limit(1);
  if (!caseRow) notFound();

  const entries = await d
    .select()
    .from(auditLog)
    .where(
      and(eq(auditLog.caseId, id), eq(auditLog.tenantId, tenantId)),
    )
    .orderBy(asc(auditLog.id));

  return (
    <>
      <div className="case-header">
        <h1>{caseRow.subject ?? "(no subject)"}</h1>
        <CaseLiveBoundary caseId={caseRow.id} />
      </div>
      <p className="muted">
        <span className={`badge ${caseRow.status}`}>{caseRow.status}</span>
        {" · "}
        {caseRow.category ?? "uncategorized"}
        {" · "}
        agent: {caseRow.currentAgentId}
        {" · "}
        opened {caseRow.createdAt.toISOString().slice(0, 16).replace("T", " ")}
      </p>

      <h2>Timeline</h2>
      <ol className="timeline">
        {entries.map((e) => (
          <li key={e.id}>
            <div className="action">{e.action}</div>
            <div className="meta">
              {e.actorType}:{e.actorId} ·{" "}
              {e.occurredAt.toISOString().slice(0, 19).replace("T", " ")}
            </div>
            {e.details ? (
              <pre
                style={{
                  background: "#fafafa",
                  padding: 8,
                  borderRadius: 4,
                  marginTop: 6,
                  fontSize: 12,
                  overflow: "auto",
                }}
              >
                {JSON.stringify(e.details, null, 2)}
              </pre>
            ) : null}
          </li>
        ))}
      </ol>

      <h2>Context</h2>
      <pre
        style={{
          background: "#fafafa",
          padding: 12,
          borderRadius: 6,
          fontSize: 13,
        }}
      >
        {JSON.stringify(caseRow.context, null, 2)}
      </pre>
    </>
  );
}
