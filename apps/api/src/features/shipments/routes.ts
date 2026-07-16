import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../../platform/context.js";
import {
  errorResponseSchema,
  webhookAckSchema,
} from "../../platform/schemas.js";
import { handleSeventeenTrackWebhook } from "./handlers.js";

export const registerShipmentRoutes = (
  app: FastifyInstance,
  { cfg }: RouteContext,
): void => {
  app.post(
    "/webhooks/tracking/seventeentrack",
    {
      schema: {
        tags: ["webhooks", "tracking"],
        summary: "17TRACK signed tracking lifecycle webhook",
        response: {
          200: webhookAckSchema,
          "4xx": errorResponseSchema,
          "5xx": errorResponseSchema,
        },
      },
    },
    async (req, res) => {
      await handleSeventeenTrackWebhook(cfg, req, res);
      return res;
    },
  );
};
