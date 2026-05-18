import { notFound } from "next/navigation";
import { asc, and, eq } from "drizzle-orm";
import { cases, auditLog } from "@support-agent/db";
import { TenantId } from "@support-agent/agent-core";
import { db } from "@/lib/db";
import { getTenantId } from "@/lib/tenant";
import { fetchCustomerForCase, fetchOrderForCase } from "@/lib/shopify";
import CaseLiveBoundary from "./CaseLiveBoundary";
import { CustomerPanel } from "./CustomerPanel";
import { OrderPanel } from "./OrderPanel";
import { takeOverAction } from "./actions";

interface Params {
  readonly params: Promise<{
    readonly id: string;
  }>;
  readonly searchParams: Promise<{
    readonly takenOver?: string;
  }>;
}

const takeOverBanner = (
  kind: string | undefined,
): { readonly tone: "success" | "info" | "warn"; readonly text: string } | null => {
  if (!kind) return null;
  if (kind === "taken_over") {
    return {
      tone: "success",
      text: "You've taken over this case. The agent will not act on it further; pending approvals were canceled.",
    };
  }
  if (kind === "already_terminal") {
    return {
      tone: "info",
      text: "This case was already in a terminal state — no change.",
    };
  }
  return null;
};

const TERMINAL = new Set(["resolved", "human_takeover", "failed"]);

export default async function CaseDetailPage({
  params,
  searchParams,
}: Params) {
  const { id } = await params;
  const sp = await searchParams;
  const banner = takeOverBanner(sp.takenOver);
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

  const context = (caseRow.context ?? {}) as Readonly<Record<string, unknown>>;
  const customerEmail =
    typeof context["customerEmail"] === "string"
      ? (context["customerEmail"] as string)
      : null;
  const orderHint =
    typeof context["identifiedOrderId"] === "string"
      ? (context["identifiedOrderId"] as string)
      : null;

  const [entries, customer, order] = await Promise.all([
    d
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.caseId, id), eq(auditLog.tenantId, tenantId)))
      .orderBy(asc(auditLog.id)),
    fetchCustomerForCase(TenantId(tenantId), context),
    fetchOrderForCase(TenantId(tenantId), context),
  ]);

  const canTakeOver = !TERMINAL.has(caseRow.status);

  return (
    <>
      {banner ? (
        <div className={`banner ${banner.tone}`}>{banner.text}</div>
      ) : null}
      <div className="case-header">
        <h1>{caseRow.subject ?? "(no subject)"}</h1>
        <CaseLiveBoundary caseId={caseRow.id} />
        {canTakeOver ? (
          <form action={takeOverAction} style={{ marginLeft: "auto" }}>
            <input type="hidden" name="caseId" value={caseRow.id} />
            <button
              type="submit"
              className="btn btn-secondary"
              title="Stop the agent on this case and handle it manually"
            >
              Take over
            </button>
          </form>
        ) : null}
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

      <div className="case-panels">
        <CustomerPanel customer={customer} customerEmail={customerEmail} />
        <OrderPanel order={order} orderHint={orderHint} />
      </div>

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
