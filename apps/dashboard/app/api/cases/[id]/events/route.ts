import { and, asc, eq, gt, desc } from "drizzle-orm";
import { auditLog, cases } from "@support-agent/db";
import { db } from "@/lib/db";
import { getTenantId } from "@/lib/tenant";

// ============================================================
// SSE: live updates for a single case
// ============================================================
//
// Master-plan §13 calls out real-time case-detail updates. This
// endpoint polls `audit_log` every ~1.5s for new rows on the given
// case and streams them as SSE `data:` lines. The client (a Client
// Component on the case detail page) reads each line and calls
// `router.refresh()` so the Server Component re-fetches and re-renders.
//
// Polling vs LISTEN/NOTIFY: polling is simpler, fits the existing
// Drizzle/pg connection pool, and has no migration cost. Throughput
// concern only at concurrent-managers-per-case > ~50, which is well
// above MVP. Future swap: a single LISTEN connection in the Node
// process multiplexed over all open SSE clients.
//
// Tenant scoping: the case must belong to the signed-in user's tenant.
// Cross-tenant access returns 404, never 403 — same disclosure-safe
// pattern as the page-level case-detail handler.

const POLL_MS = 1500;
const PING_MS = 15_000;

// audit_log.id is `bigserial` (bigint). JSON.stringify doesn't handle
// bigint; coerce to string when serializing.
const safeSerialize = (row: {
  readonly id: bigint;
  readonly action: string;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly occurredAt: Date;
}) =>
  JSON.stringify({
    id: row.id.toString(),
    action: row.action,
    actorType: row.actorType,
    actorId: row.actorId,
    occurredAt: row.occurredAt.toISOString(),
  });

interface RouteParams {
  readonly params: Promise<{ readonly id: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  const { id } = await params;
  const tenantId = await getTenantId();
  const d = db();

  // Verify the case belongs to the tenant. A miss surfaces as 404 so
  // we don't disclose existence in another tenant.
  const [caseRow] = await d
    .select({ id: cases.id })
    .from(cases)
    .where(and(eq(cases.id, id), eq(cases.tenantId, tenantId)))
    .limit(1);
  if (!caseRow) {
    return new Response("not found", { status: 404 });
  }

  // Seed lastSeen with the highest existing audit id so we only emit
  // events that arrive AFTER the client connects. The initial page
  // render already shows everything up to this point.
  const seedRows = await d
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(eq(auditLog.caseId, id))
    .orderBy(desc(auditLog.id))
    .limit(1);
  let lastSeen: bigint = seedRows[0]?.id ?? 0n;

  const enc = new TextEncoder();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(enc.encode(chunk));
        } catch {
          // Stream may already be closed by the client disconnect
          // handler — ignore. The interval cleanup below catches the
          // next tick.
        }
      };

      // Tell the browser to retry after 2s on disconnect (default is
      // 3s; tighter feels snappier in dev). Then a comment-line ping
      // so proxies don't kill an idle connection.
      send("retry: 2000\n\n");
      send(": connected\n\n");

      const poll = async () => {
        try {
          const rows = await d
            .select({
              id: auditLog.id,
              action: auditLog.action,
              actorType: auditLog.actorType,
              actorId: auditLog.actorId,
              occurredAt: auditLog.occurredAt,
            })
            .from(auditLog)
            .where(
              and(eq(auditLog.caseId, id), gt(auditLog.id, lastSeen)),
            )
            .orderBy(asc(auditLog.id))
            .limit(50);
          for (const row of rows) {
            lastSeen = row.id;
            send(`data: ${safeSerialize(row)}\n\n`);
          }
        } catch (cause) {
          // Transient DB error — don't kill the stream. Log + the
          // next interval will retry.
          // eslint-disable-next-line no-console
          console.error("[case-sse] poll error", cause);
        }
      };

      pollTimer = setInterval(poll, POLL_MS);
      pingTimer = setInterval(() => send(": ping\n\n"), PING_MS);

      const onAbort = () => {
        if (pollTimer) clearInterval(pollTimer);
        if (pingTimer) clearInterval(pingTimer);
        pollTimer = null;
        pingTimer = null;
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };
      req.signal.addEventListener("abort", onAbort);
    },
    cancel() {
      if (pollTimer) clearInterval(pollTimer);
      if (pingTimer) clearInterval(pingTimer);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Some reverse proxies (nginx) buffer SSE by default. This hint
      // disables that for the response. Harmless when not behind nginx.
      "X-Accel-Buffering": "no",
    },
  });
}
