import { type FastifyReply, type FastifyRequest } from "fastify";
import {
  decideApproval,
  extractToken,
  makePgBossApprovalPublisher,
  matchApprovalRoute,
  renderApprovalConfirmPage,
  renderApprovalPage,
  verifyApprovalLink,
} from "./endpoints.js";
import {
  decideBundleFromLink,
  loadBundleReview,
  renderBundleDecisionPage,
  renderBundleReviewErrorPage,
  renderBundleReviewPage,
} from "./bundle-endpoints.js";
import { acquireApprovalBoss } from "../../platform/pgboss.js";
import { type ApiConfig, type ApiLayer } from "../../bootstrap.js";
import { sendHtml, sendJson } from "../../platform/http.js";

/**
 * GET /approvals/:id/:action — verification + confirmation page ONLY.
 * Email-security scanners (Outlook SafeLinks, Mimecast, Gmail prefetch)
 * follow GET links in inbound mail; a GET that decided the approval let
 * a scanner silently approve refunds before the manager ever opened the
 * email (audit S2). The actual decision happens in the POST below.
 */
export const handleApprovalConfirmPage = (
  cfg: ApiConfig,
  req: FastifyRequest,
  res: FastifyReply,
): void => {
  const url = req.url ?? "/";
  const pathOnly = url.split("?")[0] ?? "";
  const match = matchApprovalRoute(pathOnly);
  if (!match) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  const token = extractToken(url);
  if (!token) {
    sendHtml(
      res,
      400,
      renderApprovalPage(
        { kind: "bad_token", reason: { ok: false, reason: "malformed" } },
        match.action,
      ).body,
    );
    return;
  }
  const linkCheck = verifyApprovalLink({
    approvalId: match.approvalId,
    action: match.action,
    token,
    signingKey: cfg.approvalSigningKey,
  });
  if (linkCheck.kind !== "ok") {
    const page = renderApprovalPage(linkCheck, match.action);
    sendHtml(res, page.status, page.body);
    return;
  }
  const page = renderApprovalConfirmPage(
    {
      approvalId: match.approvalId,
      action: match.action,
      token,
    },
    { dashboardBaseUrl: cfg.dashboardBaseUrl },
  );
  sendHtml(res, page.status, page.body);
};

/**
 * Extract the token from a POST body. The server buffers every body as
 * raw bytes (webhook HMAC requirement), so the urlencoded confirm-form
 * body is parsed here. Keeping the token in the POST body (not the URL)
 * also keeps it out of request logs (audit S6).
 */
export const extractTokenFromPostBody = (body: unknown): string | null => {
  if (!Buffer.isBuffer(body)) return null;
  try {
    const params = new URLSearchParams(body.toString("utf8"));
    return params.get("token");
  } catch {
    return null;
  }
};

export const handleApprovalDecision = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> => {
  const url = req.url ?? "/";
  // Match the path BEFORE the query string.
  const pathOnly = url.split("?")[0] ?? "";
  const match = matchApprovalRoute(pathOnly);
  if (!match) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  // Token comes from the confirm-form's POST body; the query-string
  // fallback keeps curl/scripted flows working.
  const token = extractTokenFromPostBody(req.body) ?? extractToken(url);
  if (!token) {
    sendHtml(
      res,
      400,
      renderApprovalPage(
        { kind: "bad_token", reason: { ok: false, reason: "malformed" } },
        match.action,
      ).body,
    );
    return;
  }

  const outcome = await decideApproval({
    approvalId: match.approvalId,
    action: match.action,
    token,
    signingKey: cfg.approvalSigningKey,
    layer,
    publish: makePgBossApprovalPublisher(() =>
      acquireApprovalBoss(cfg.databaseUrl),
    ),
  });

  const page = renderApprovalPage(outcome, match.action, {
    dashboardBaseUrl: cfg.dashboardBaseUrl,
  });
  sendHtml(res, page.status, page.body);
};

// ============================================================
// Bundle review (queued-approvals magic link)
// ============================================================

const UUID_RE = /^[0-9a-f-]{36}$/iu;

/**
 * GET /approvals/bundle/:ticketId — verification + review page ONLY.
 * Lists every queued action so the merchant sees what they're approving;
 * the decision happens in the POST below (audit S2 — Telegram's link
 * preview fetcher follows every sent URL, exactly like email scanners).
 */
export const handleBundleReviewPage = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> => {
  const { ticketId } = req.params as { ticketId: string };
  if (!UUID_RE.test(ticketId)) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  const pageOpts = { ticketId, dashboardBaseUrl: cfg.dashboardBaseUrl };
  const token = extractToken(req.url ?? "/");
  if (!token) {
    const page = renderBundleReviewErrorPage(
      { kind: "bad_token", reason: "malformed" },
      pageOpts,
    );
    sendHtml(res, page.status, page.body);
    return;
  }
  const outcome = await loadBundleReview({
    ticketId,
    token,
    signingKey: cfg.approvalSigningKey,
    layer,
  });
  if (outcome.kind === "ok") {
    const page = renderBundleReviewPage({
      ticket: outcome.ticket,
      pending: outcome.pending,
      token,
      dashboardBaseUrl: cfg.dashboardBaseUrl,
    });
    sendHtml(res, page.status, page.body);
    return;
  }
  const page = renderBundleReviewErrorPage(outcome, pageOpts);
  sendHtml(res, page.status, page.body);
};

/**
 * POST /approvals/bundle/:ticketId/:action — decide the WHOLE pending
 * bundle (confirm-page POST). Token in the body, same as the single-
 * approval confirm form (audit S6 — keeps it out of request logs).
 */
export const handleBundleDecision = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> => {
  const { ticketId, action } = req.params as {
    ticketId: string;
    action: string;
  };
  if (!UUID_RE.test(ticketId) || (action !== "approve" && action !== "reject")) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  const pageOpts = { ticketId, dashboardBaseUrl: cfg.dashboardBaseUrl };
  const token = extractTokenFromPostBody(req.body) ?? extractToken(req.url ?? "/");
  if (!token) {
    const page = renderBundleReviewErrorPage(
      { kind: "bad_token", reason: "malformed" },
      pageOpts,
    );
    sendHtml(res, page.status, page.body);
    return;
  }
  const outcome = await decideBundleFromLink({
    ticketId,
    action,
    token,
    signingKey: cfg.approvalSigningKey,
    layer,
    publish: makePgBossApprovalPublisher(() =>
      acquireApprovalBoss(cfg.databaseUrl),
    ),
  });
  const page =
    outcome.kind === "decided" || outcome.kind === "no_pending"
      ? renderBundleDecisionPage(outcome, pageOpts)
      : renderBundleReviewErrorPage(outcome, pageOpts);
  sendHtml(res, page.status, page.body);
};
