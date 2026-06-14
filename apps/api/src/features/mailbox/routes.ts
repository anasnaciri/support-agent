import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../../platform/context.js";
import {
  errorResponseSchema,
  gmailParamsSchema,
  googleCallbackQuerySchema,
  googleCallbackSuccessSchema,
  googleInstallQuerySchema,
  tokenQuerySchema,
  webhookAckSchema,
} from "../../platform/schemas.js";
import {
  handleGmailWebhook,
  handleGoogleCallback,
  handleGoogleInstall,
  handleGraphWebhook,
  handleMicrosoftCallback,
  handleMicrosoftInstall,
} from "./handlers.js";

export const registerMailboxRoutes = (
  app: FastifyInstance,
  { cfg, layer }: RouteContext,
): void => {
  const errorResponses = {
    "4xx": errorResponseSchema,
    "5xx": errorResponseSchema,
  };

  // ---- Google / Gmail OAuth ----
  app.get(
    "/google/install",
    {
      schema: {
        tags: ["google"],
        summary: "Start the Google / Gmail OAuth install flow",
        querystring: googleInstallQuerySchema,
        response: errorResponses,
      },
    },
    async (req, res) => {
      await handleGoogleInstall(cfg, layer, req, res);
      return res;
    },
  );

  app.get(
    "/google/auth/callback",
    {
      schema: {
        tags: ["google"],
        summary: "Google OAuth authorization-code callback",
        querystring: googleCallbackQuerySchema,
        response: { 200: googleCallbackSuccessSchema, ...errorResponses },
      },
    },
    async (req, res) => {
      await handleGoogleCallback(cfg, layer, req, res);
      return res;
    },
  );

  // ---- Microsoft / Outlook OAuth ----
  app.get(
    "/microsoft/install",
    {
      schema: {
        tags: ["microsoft"],
        summary: "Start the Microsoft / Outlook OAuth install flow",
        querystring: googleInstallQuerySchema,
        response: errorResponses,
      },
    },
    async (req, res) => {
      await handleMicrosoftInstall(cfg, layer, req, res);
      return res;
    },
  );

  app.get(
    "/microsoft/auth/callback",
    {
      schema: {
        tags: ["microsoft"],
        summary: "Microsoft OAuth authorization-code callback",
        querystring: googleCallbackQuerySchema,
        response: errorResponses,
      },
    },
    async (req, res) => {
      await handleMicrosoftCallback(cfg, layer, req, res);
      return res;
    },
  );

  // ---- Gmail Pub/Sub push webhook (tenant-less + legacy tenant path) ----
  const gmailWebhookOpts = {
    schema: {
      tags: ["webhooks", "google"],
      summary: "Gmail Pub/Sub push notification",
      querystring: tokenQuerySchema,
      response: { 200: webhookAckSchema, ...errorResponses },
    },
  };
  app.post("/webhooks/conversations/gmail", gmailWebhookOpts, async (req, res) => {
    await handleGmailWebhook(cfg, layer, req, res);
    return res;
  });
  app.post(
    "/webhooks/conversations/gmail/:tenantId",
    {
      schema: {
        ...gmailWebhookOpts.schema,
        params: gmailParamsSchema,
      },
    },
    async (req, res) => {
      await handleGmailWebhook(cfg, layer, req, res);
      return res;
    },
  );

  // ---- Microsoft Graph change-notification webhook ----
  app.post(
    "/webhooks/conversations/outlook/:tenantId",
    {
      schema: {
        tags: ["webhooks", "microsoft"],
        summary: "Microsoft Graph mailbox change notification",
        params: gmailParamsSchema,
        response: errorResponses,
      },
    },
    async (req, res) => {
      await handleGraphWebhook(cfg, layer, req, res);
      return res;
    },
  );
};
