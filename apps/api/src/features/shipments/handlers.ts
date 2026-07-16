import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  parseSeventeenTrackWebhook,
  verifySeventeenTrackWebhookSignature,
} from "@support-agent/providers";
import type { ApiConfig } from "../../bootstrap.js";
import { sendJson } from "../../platform/http.js";
import { shipmentPublisher } from "../../platform/pgboss.js";

export const handleSeventeenTrackWebhook = async (
  cfg: ApiConfig,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> => {
  const apiKey = process.env["SEVENTEENTRACK_API_KEY"];
  if (!apiKey) {
    sendJson(res, 503, { error: "tracking_webhook_not_configured" });
    return;
  }
  const header = req.headers["sign"];
  const signature = Array.isArray(header) ? header[0] : header;
  const rawBody = req.body as Buffer;
  if (
    !signature ||
    !verifySeventeenTrackWebhookSignature(rawBody, signature, apiKey)
  ) {
    sendJson(res, 401, { error: "signature_verification_failed" });
    return;
  }
  const update = parseSeventeenTrackWebhook(rawBody);
  if (!update) {
    sendJson(res, 200, { ok: true, action: "noop_unsupported" });
    return;
  }
  try {
    await shipmentPublisher(cfg.databaseUrl)({
      kind: "seventeentrack.update",
      shipmentId: update.shipmentId,
      fingerprint: createHash("sha256").update(rawBody).digest("hex"),
      status: update.status,
      occurredAt: update.occurredAt.toISOString(),
      lastScanAt: update.lastScanAt?.toISOString() ?? null,
      transitDays: update.transitDays,
      destinationCountry: update.destinationCountry,
    });
  } catch (cause) {
    req.log.error({ err: cause }, "[17track webhook] enqueue failed");
    sendJson(res, 503, { error: "shipment_enqueue_failed" });
    return;
  }
  sendJson(res, 200, { ok: true, action: "enqueued" });
};
