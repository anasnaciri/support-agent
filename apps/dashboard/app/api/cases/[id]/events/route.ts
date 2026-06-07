import { getSession } from "@/lib/session";
import { api } from "@/lib/api-client";

// ============================================================
// Live case updates — same-origin poll proxy (Path B)
// ============================================================
//
// The case-detail client polls this route on an interval. The dashboard holds
// the api service token server-side, so the browser can't call apps/api
// directly — this thin route authenticates the merchant via WorkOS and
// forwards to GET /dashboard/cases/:id/events?since=, returning the new audit
// rows as JSON. (Pre-cutover this was a DB-poll SSE stream.)

interface RouteParams {
  readonly params: Promise<{ readonly id: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  const { id } = await params;
  const { user, organizationId } = await getSession();
  if (!user || !organizationId) {
    return new Response("unauthorized", { status: 401 });
  }
  const since = new URL(req.url).searchParams.get("since") ?? "0";
  const result = await api.caseEvents({ organizationId }, id, since);
  if (!result) return new Response("not found", { status: 404 });
  return Response.json(result, {
    headers: { "Cache-Control": "no-store" },
  });
}
