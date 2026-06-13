import { cookies } from "next/headers";

import { getSessionOrRefresh } from "@/lib/session";
import { api } from "@/lib/api-client";
import { parsePageNumber, parsePageSize } from "@/lib/pagination";
import { WORKSPACE_COOKIE } from "@/lib/workspace";

// ============================================================
// Cases list — same-origin proxy for the case-switcher sidebar (Path B)
// ============================================================
//
// The CasesSidebar client component fetches this route to page through and
// search the tenant's cases (infinite scroll). The dashboard holds the api
// service token server-side, so the browser can't call apps/api directly —
// this thin route authenticates the merchant via WorkOS and forwards to
// GET /dashboard/cases?q=&page=&limit=, returning Page<CaseListRow> as JSON.

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
  const q = params.get("q") ?? undefined;
  // Same workspace pin as the RSC pages, or the sidebar would list the
  // DEFAULT workspace's cases next to another workspace's case detail. A
  // stale cookie (workspace deleted in another tab) 404s api-side; surface
  // that as 404 so the sidebar degrades instead of a 500 — the next full
  // navigation re-resolves the workspace.
  const workspaceId = (await cookies()).get(WORKSPACE_COOKIE)?.value;
  let result;
  try {
    result = await api.cases(
      { accessToken, ...(workspaceId ? { workspaceId } : {}) },
      page,
      limit,
      q,
    );
  } catch {
    return new Response("not found", { status: 404 });
  }
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}
