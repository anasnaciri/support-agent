import { getSession } from "@/lib/session";
import { api } from "@/lib/api-client";
import { parsePageNumber, parsePageSize } from "@/lib/pagination";

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
  const { user, organizationId } = await getSession();
  if (!user || !organizationId) {
    return new Response("unauthorized", { status: 401 });
  }
  const params = new URL(req.url).searchParams;
  const page = parsePageNumber(params.get("page") ?? undefined);
  const limit = parsePageSize(params.get("limit") ?? undefined);
  const q = params.get("q") ?? undefined;
  const result = await api.cases({ organizationId }, page, limit, q);
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}
