import { Effect } from "effect";
import { createHash } from "node:crypto";
import { type FastifyReply, type FastifyRequest } from "fastify";
import {
  KnowledgeBaseService,
  UrlFetchService,
} from "@support-agent/services";
import { TenantId } from "@support-agent/agent-core";
import { knowledgeDocuments } from "@support-agent/db";
import { type ApiConfig, type ApiLayer } from "../../bootstrap.js";
import { sendJson, parseJsonBody } from "../../platform/http.js";
import { runWithDb, authenticateDashboard } from "../../auth/dashboard-context.js";

// ============================================================
// Knowledge base (settings/knowledge) — policy / reference documents the
// support agents consult via the knowledge.search tool.
// ============================================================

export const KB_MAX_DOCS_PER_TENANT = 50;
export const KB_MAX_CONTENT_CHARS = 100_000;
export const KB_MAX_TITLE_CHARS = 200;
export const KB_MAX_URL_CHARS = 2_000;
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const hashContent = (s: string): string =>
  createHash("sha256").update(s, "utf8").digest("hex");

/** Run an effect needing only KnowledgeBaseService against the api layer. */
export const runWithKnowledge = <A>(
  layer: ApiLayer,
  f: (kb: typeof KnowledgeBaseService.Service) => Effect.Effect<A, unknown, never>,
): Promise<A> =>
  Effect.runPromise(
    Effect.provide(
      Effect.flatMap(KnowledgeBaseService, f),
      layer,
    ) as Effect.Effect<A, unknown, never>,
  ) as Promise<A>;

/** Fetch + extract a tenant-supplied URL via the SSRF-guarded service. */
export const fetchKnowledgeUrl = (
  layer: ApiLayer,
  url: string,
): Promise<
  | { ok: true; text: string; finalUrl: string }
  | { ok: false; reason: string }
> =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const svc = yield* UrlFetchService;
        const either = yield* svc.fetch(url).pipe(Effect.either);
        return either._tag === "Left"
          ? ({ ok: false as const, reason: either.left.kind })
          : ({
              ok: true as const,
              text: either.right.text,
              finalUrl: either.right.finalUrl,
            });
      }),
      layer,
    ),
  );

// GET /dashboard/knowledge — list document summaries (no content).
export const handleDashboardKnowledgeList = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const documents = await runWithDb(layer, (db) =>
    knowledgeDocuments(db, auth.tenantId),
  );
  return sendJson(res, 200, { documents });
};

// GET /dashboard/knowledge/:id — one full document (for the editor).
export const handleDashboardKnowledgeGet = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  if (!UUID_RE.test(id)) return sendJson(res, 404, { error: "not_found" });
  const doc = await runWithKnowledge(layer, (kb) =>
    kb.get(TenantId(auth.tenantId), id),
  );
  if (!doc) return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, 200, {
    document: {
      id: doc.id,
      title: doc.title,
      content: doc.content,
      sourceType: doc.sourceType,
      sourceUrl: doc.sourceUrl,
      fetchedAt: doc.fetchedAt ? doc.fetchedAt.toISOString() : null,
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
    },
  });
};

// POST /dashboard/knowledge — create a document from pasted text or a URL.
export const handleDashboardKnowledgeCreate = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const body = parseJsonBody(req);
  const title =
    typeof body["title"] === "string" ? body["title"].trim() : "";
  if (!title || title.length > KB_MAX_TITLE_CHARS) {
    return sendJson(res, 400, { error: "invalid_title" });
  }
  const sourceType = body["sourceType"];
  if (sourceType !== "text" && sourceType !== "url") {
    return sendJson(res, 400, { error: "invalid_source_type" });
  }

  const count = await runWithKnowledge(layer, (kb) =>
    kb.count(TenantId(auth.tenantId)),
  );
  if (count >= KB_MAX_DOCS_PER_TENANT) {
    return sendJson(res, 403, { error: "too_many_documents" });
  }

  let content: string;
  let sourceUrl: string | null = null;
  let fetchedAt: Date | null = null;

  if (sourceType === "text") {
    content = typeof body["content"] === "string" ? body["content"] : "";
    if (!content.trim()) return sendJson(res, 400, { error: "missing_content" });
    if (content.length > KB_MAX_CONTENT_CHARS) {
      return sendJson(res, 400, { error: "content_too_large" });
    }
  } else {
    const url = typeof body["sourceUrl"] === "string" ? body["sourceUrl"].trim() : "";
    if (!url || url.length > KB_MAX_URL_CHARS) {
      return sendJson(res, 400, { error: "invalid_url" });
    }
    const fetched = await fetchKnowledgeUrl(layer, url);
    if (!fetched.ok) {
      return sendJson(res, 400, { error: "fetch_failed", reason: fetched.reason });
    }
    content = fetched.text.slice(0, KB_MAX_CONTENT_CHARS);
    sourceUrl = fetched.finalUrl;
    fetchedAt = new Date();
  }

  const created = await runWithKnowledge(layer, (kb) =>
    kb.create(TenantId(auth.tenantId), {
      title,
      content,
      sourceType,
      sourceUrl,
      contentHash: hashContent(content),
      fetchedAt,
    }),
  );
  return sendJson(res, 200, { ok: true, id: created.id });
};

// POST /dashboard/knowledge/:id — edit title (any doc) and/or content (text docs).
export const handleDashboardKnowledgeUpdate = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  if (!UUID_RE.test(id)) return sendJson(res, 404, { error: "not_found" });
  const body = parseJsonBody(req);

  const doc = await runWithKnowledge(layer, (kb) =>
    kb.get(TenantId(auth.tenantId), id),
  );
  if (!doc) return sendJson(res, 404, { error: "not_found" });

  const patch: {
    title?: string;
    content?: string;
    contentHash?: string;
  } = {};
  if (typeof body["title"] === "string") {
    const t = body["title"].trim();
    if (!t || t.length > KB_MAX_TITLE_CHARS) {
      return sendJson(res, 400, { error: "invalid_title" });
    }
    patch.title = t;
  }
  if (typeof body["content"] === "string") {
    if (doc.sourceType !== "text") {
      return sendJson(res, 400, { error: "cannot_edit_url_content" });
    }
    const c = body["content"];
    if (!c.trim()) return sendJson(res, 400, { error: "missing_content" });
    if (c.length > KB_MAX_CONTENT_CHARS) {
      return sendJson(res, 400, { error: "content_too_large" });
    }
    patch.content = c;
    patch.contentHash = hashContent(c);
  }

  const updated = await runWithKnowledge(layer, (kb) =>
    kb.update(TenantId(auth.tenantId), id, patch),
  );
  if (!updated) return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, 200, { ok: true });
};

// POST /dashboard/knowledge/:id/delete — remove a document.
export const handleDashboardKnowledgeDelete = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  if (!UUID_RE.test(id)) return sendJson(res, 404, { error: "not_found" });
  const removed = await runWithKnowledge(layer, (kb) =>
    kb.remove(TenantId(auth.tenantId), id),
  );
  if (!removed) return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, 200, { ok: true });
};

// POST /dashboard/knowledge/:id/resync — re-fetch a `url` doc's snapshot.
export const handleDashboardKnowledgeResync = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  if (!UUID_RE.test(id)) return sendJson(res, 404, { error: "not_found" });
  const doc = await runWithKnowledge(layer, (kb) =>
    kb.get(TenantId(auth.tenantId), id),
  );
  if (!doc) return sendJson(res, 404, { error: "not_found" });
  if (doc.sourceType !== "url" || !doc.sourceUrl) {
    return sendJson(res, 400, { error: "not_a_url_doc" });
  }
  const fetched = await fetchKnowledgeUrl(layer, doc.sourceUrl);
  if (!fetched.ok) {
    return sendJson(res, 400, { error: "fetch_failed", reason: fetched.reason });
  }
  const content = fetched.text.slice(0, KB_MAX_CONTENT_CHARS);
  const contentHash = hashContent(content);
  if (contentHash === doc.contentHash) {
    return sendJson(res, 200, { ok: true, changed: false });
  }
  await runWithKnowledge(layer, (kb) =>
    kb.update(TenantId(auth.tenantId), id, {
      content,
      contentHash,
      fetchedAt: new Date(),
    }),
  );
  return sendJson(res, 200, { ok: true, changed: true });
};
