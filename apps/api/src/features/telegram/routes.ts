import { Effect } from "effect";
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../../platform/context.js";
import { errorResponseSchema } from "../../platform/schemas.js";
import { parseJsonBody, sendJson } from "../../platform/http.js";
import {
  isTelegramWebhookAuthorized,
  processTelegramUpdate,
} from "./webhook.js";

export const registerTelegramRoutes = (
  app: FastifyInstance,
  { cfg, layer }: RouteContext,
): void => {
  const errorResponses = {
    "4xx": errorResponseSchema,
    "5xx": errorResponseSchema,
  };

  // ---- Telegram bot webhook (merchant notification channel linking) ----
  app.post(
    "/webhooks/notifications/telegram",
    {
      schema: {
        tags: ["webhooks", "telegram"],
        summary: "Telegram bot update (chat linking via /start)",
        response: errorResponses,
      },
    },
    async (req, res) => {
      if (!cfg.telegram) {
        return sendJson(res, 503, { error: "telegram_not_configured" });
      }
      const secretHeader = req.headers["x-telegram-bot-api-secret-token"];
      if (
        !isTelegramWebhookAuthorized(
          typeof secretHeader === "string" ? secretHeader : undefined,
          cfg.telegram.webhookSecret,
        )
      ) {
        return sendJson(res, 401, { error: "unauthorized" });
      }
      const outcome = await Effect.runPromise(
        Effect.provide(
          processTelegramUpdate(parseJsonBody(req), {
            signingKey: cfg.stateSigningKey,
            botToken: cfg.telegram.botToken,
          }),
          layer,
        ),
      );
      // Always 2xx after auth — Telegram retries non-2xx and a retry
      // can't fix an invalid token or an ignorable update.
      return sendJson(res, 200, { ok: true, outcome });
    },
  );
};
