import Link from "next/link";
import { and, desc, eq, like, lt, type SQL } from "drizzle-orm";
import { auditLog } from "@support-agent/db";
import { db } from "@/lib/db";
import { getTenantId } from "@/lib/tenant";

// Master-plan §13: "Audit Log · Per-tenant chronological log; filterable."
// MVP filters: action prefix, actor type. Cursor pagination via `?after=<id>`
// where `after` is the bigserial id of the OLDEST row currently shown —
// clicking "Older" advances past it. Newer pages are reachable by
// removing the cursor (the page always renders newest-first).

const ACTION_FILTERS = [
  { label: "Any action", value: "" },
  { label: "Tool invocations", value: "tool.invoked" },
  { label: "LLM decisions", value: "llm.decision" },
  { label: "Events received", value: "event.received" },
  { label: "Case resolved", value: "case.resolved" },
  { label: "Escalated to human", value: "case.escalated_to_human" },
  { label: "Compliance webhooks", value: "compliance." },
] as const;

const ACTOR_FILTERS = [
  { label: "Any actor", value: "" },
  { label: "System", value: "system" },
  { label: "Agent", value: "agent" },
  { label: "User (manager)", value: "user" },
] as const;

const PAGE_SIZE = 100;

const formatDetails = (details: unknown): string => {
  if (!details || typeof details !== "object") return "";
  const obj = details as Record<string, unknown>;
  // Pick the fields a manager actually scans for. Falls back to a
  // compact JSON dump for unknown shapes.
  const interesting: Array<[string, string]> = [];
  for (const k of ["tool", "target", "decisionType", "eventType", "viaApprovalId", "ok"] as const) {
    if (k in obj) interesting.push([k, String(obj[k])]);
  }
  if (interesting.length > 0) {
    return interesting.map(([k, v]) => `${k}=${v}`).join(" · ");
  }
  try {
    return JSON.stringify(obj).slice(0, 120);
  } catch {
    return "";
  }
};

interface SearchParams {
  readonly searchParams: Promise<{
    readonly action?: string;
    readonly actor?: string;
    readonly after?: string;
  }>;
}

export default async function AuditLogPage({ searchParams }: SearchParams) {
  const tenantId = await getTenantId();
  const sp = await searchParams;
  const actionFilter = sp.action ?? "";
  const actorFilter = sp.actor ?? "";
  const after = sp.after ? safeBigInt(sp.after) : null;

  const whereParts: SQL[] = [eq(auditLog.tenantId, tenantId)];
  if (actionFilter) {
    // Prefix match — `tool.invoked` matches `tool.invoked`, `compliance.`
    // matches every `compliance.*` action. Using LIKE keeps the query
    // simple; the column is short (~30 chars) so a sequential scan over
    // the per-tenant slice is fine for MVP.
    whereParts.push(like(auditLog.action, `${actionFilter}%`));
  }
  if (actorFilter) {
    whereParts.push(eq(auditLog.actorType, actorFilter));
  }
  if (after !== null) {
    whereParts.push(lt(auditLog.id, after));
  }

  const rows = await db()
    .select({
      id: auditLog.id,
      caseId: auditLog.caseId,
      action: auditLog.action,
      actorType: auditLog.actorType,
      actorId: auditLog.actorId,
      occurredAt: auditLog.occurredAt,
      details: auditLog.details,
    })
    .from(auditLog)
    .where(and(...whereParts))
    .orderBy(desc(auditLog.id))
    .limit(PAGE_SIZE);

  const lastRow = rows[rows.length - 1];
  const hasMore = rows.length === PAGE_SIZE && lastRow !== undefined;
  const olderQuery = (() => {
    const qs = new URLSearchParams();
    if (actionFilter) qs.set("action", actionFilter);
    if (actorFilter) qs.set("actor", actorFilter);
    if (lastRow) qs.set("after", lastRow.id.toString());
    return qs.toString();
  })();

  const resetQuery = (() => {
    const qs = new URLSearchParams();
    if (actionFilter) qs.set("action", actionFilter);
    if (actorFilter) qs.set("actor", actorFilter);
    return qs.toString();
  })();

  return (
    <>
      <h1>Audit log</h1>
      <p className="muted">
        Cross-case chronological view. Tenant-scoped, newest first.
      </p>

      <form method="get" className="filter-bar">
        <label>
          Action
          <select name="action" defaultValue={actionFilter}>
            {ACTION_FILTERS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Actor
          <select name="actor" defaultValue={actorFilter}>
            {ACTOR_FILTERS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn btn-primary">Apply</button>
        {after !== null ? (
          <Link href={`/audit?${resetQuery}`} className="muted">
            ← Back to newest
          </Link>
        ) : null}
      </form>

      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Action</th>
            <th>Actor</th>
            <th>Case</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={5} className="muted" style={{ textAlign: "center" }}>
                No audit entries match these filters.
              </td>
            </tr>
          ) : null}
          {rows.map((r) => (
            <tr key={r.id.toString()}>
              <td>
                {r.occurredAt.toISOString().slice(0, 19).replace("T", " ")}
              </td>
              <td>
                <code>{r.action}</code>
              </td>
              <td>
                <span className={`badge ${r.actorType}`}>{r.actorType}</span>
                {r.actorId ? <span className="muted"> {r.actorId}</span> : null}
              </td>
              <td>
                {r.caseId ? (
                  <Link href={`/cases/${r.caseId}`}>
                    {r.caseId.slice(0, 8)}…
                  </Link>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
              <td className="muted" style={{ fontSize: 12 }}>
                {formatDetails(r.details)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {hasMore ? (
        <p style={{ marginTop: 16 }}>
          <Link href={`/audit?${olderQuery}`} className="btn btn-secondary">
            Older →
          </Link>
        </p>
      ) : (
        <p className="muted" style={{ marginTop: 16 }}>
          End of log.
        </p>
      )}
    </>
  );
}

const safeBigInt = (s: string): bigint | null => {
  try {
    if (!/^\d+$/u.test(s)) return null;
    return BigInt(s);
  } catch {
    return null;
  }
};
