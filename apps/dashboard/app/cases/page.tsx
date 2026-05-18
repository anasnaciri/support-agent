import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { cases } from "@support-agent/db";
import { db } from "@/lib/db";
import { getTenantId } from "@/lib/tenant";

export default async function CasesPage() {
  const tenantId = await getTenantId();
  const rows = await db()
    .select({
      id: cases.id,
      subject: cases.subject,
      status: cases.status,
      category: cases.category,
      currentAgentId: cases.currentAgentId,
      createdAt: cases.createdAt,
      updatedAt: cases.updatedAt,
    })
    .from(cases)
    .where(eq(cases.tenantId, tenantId))
    .orderBy(desc(cases.updatedAt))
    .limit(100);

  return (
    <>
      <h1>Cases</h1>
      <p className="muted">Last 100 by activity.</p>
      <table>
        <thead>
          <tr>
            <th>Subject</th>
            <th>Status</th>
            <th>Category</th>
            <th>Agent</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <Link href={`/cases/${r.id}`}>
                  {r.subject ?? "(no subject)"}
                </Link>
              </td>
              <td>
                <span className={`badge ${r.status}`}>{r.status}</span>
              </td>
              <td>{r.category ?? "—"}</td>
              <td>{r.currentAgentId}</td>
              <td>{r.updatedAt.toISOString().slice(0, 16).replace("T", " ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
