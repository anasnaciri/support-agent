import { cookies } from "next/headers";

import { getSessionOrRefresh } from "@/lib/session";
import { api } from "@/lib/api-client";
import { parsePageNumber, parsePageSize } from "@/lib/pagination";
import { WORKSPACE_COOKIE } from "@/lib/workspace";

// ============================================================
// Tickets list — same-origin proxy for the ticket-switcher sidebar (Path B)
// ============================================================
//
// The TicketsSidebar client component fetches this route to page through and
// search the tenant's tickets (infinite scroll). The dashboard holds the api
// service token server-side, so the browser can't call apps/api directly —
// this thin route authenticates the merchant via WorkOS and forwards to
// GET /dashboard/tickets?q=&status=&excludeStatus=&page=&limit=, returning
// Page<TicketListRow> as JSON. The sidebar's "Needs attention" mode passes
// excludeStatus=resolved.

export async function GET(req: Request) {
  // Route handlers CAN Set-Cookie, so an expired-mid-session access token is
  // refreshed here (U1) — an open tab's polling keeps the session alive
  // instead of decaying into permanent 401s.
  const { user, organizationId, accessToken } = await getSessionOrRefresh();
  if (!user || !organizationId || !accessToken) {
    return new Response("unauthorized", { status: 401 });
  }
  const params = new URL(req.url).searchParams;
  const page = parsePageNumber(params.get("page") ?? undefined);
  const limit = parsePageSize(params.get("limit") ?? undefined);
  const filter = {
    q: params.get("q") ?? undefined,
    status: params.getAll("status"),
    excludeStatus: params.getAll("excludeStatus"),
  };
  // Same workspace pin as the RSC pages, or the sidebar would list the
  // DEFAULT workspace's tickets next to another workspace's ticket detail. A
  // stale cookie (workspace deleted in another tab) 404s api-side; surface
  // that as 404 so the sidebar degrades instead of a 500 — the next full
  // navigation re-resolves the workspace.
  const workspaceId = (await cookies()).get(WORKSPACE_COOKIE)?.value;
  let result;
  try {
    result = await api.tickets(
      { accessToken, ...(workspaceId ? { workspaceId } : {}) },
      filter,
      page,
      limit,
    );
  } catch {
    return new Response("not found", { status: 404 });
  }
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}
