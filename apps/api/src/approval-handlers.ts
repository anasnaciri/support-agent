import { type FastifyReply, type FastifyRequest } from "fastify";
import {
  decideApproval,
  extractToken,
  makePgBossApprovalPublisher,
  matchApprovalRoute,
  renderApprovalConfirmPage,
  renderApprovalPage,
  verifyApprovalLink,
} from "./approval-endpoints.js";
import { acquireApprovalBoss } from "./pgboss.js";
import { type ApiConfig, type ApiLayer } from "./bootstrap.js";
import { sendHtml, sendJson } from "./http.js";

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
  const page = renderApprovalConfirmPage({
    approvalId: match.approvalId,
    action: match.action,
    token,
  });
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
