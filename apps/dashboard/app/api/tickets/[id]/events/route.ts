import { cookies } from "next/headers";

import { getSessionOrRefresh } from "@/lib/session";
import { api } from "@/lib/api-client";
import { WORKSPACE_COOKIE } from "@/lib/workspace";

// ============================================================
// Live ticket updates — same-origin poll proxy (Path B)
// ============================================================
//
// The ticket-detail client polls this route on an interval. The dashboard holds
// the api service token server-side, so the browser can't call apps/api
// directly — this thin route authenticates the merchant via WorkOS and
// forwards to GET /dashboard/tickets/:id/events?since=, returning the new audit
// rows as JSON. (Pre-cutover this was a DB-poll SSE stream.)

interface RouteParams {
  readonly params: Promise<{ readonly id: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  const { id } = await params;
  // Refresh an expired-mid-session token while we can still Set-Cookie (U1)
  // — keeps an open ticket tab's live-updates poll authenticated.
  const { user, organizationId, accessToken } = await getSessionOrRefresh();
  if (!user || !organizationId || !accessToken) {
    return new Response("unauthorized", { status: 401 });
  }
  const since = new URL(req.url).searchParams.get("since") ?? "0";
  // Pin to the active workspace like the page that opened this poll.
  const workspaceId = (await cookies()).get(WORKSPACE_COOKIE)?.value;
  const result = await api.ticketEvents(
    { accessToken, ...(workspaceId ? { workspaceId } : {}) },
    id,
    since,
  );
  if (!result) return new Response("not found", { status: 404 });
  return Response.json(result, {
    headers: { "Cache-Control": "no-store" },
  });
}
