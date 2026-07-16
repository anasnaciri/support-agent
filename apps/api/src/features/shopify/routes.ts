import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../../platform/context.js";
import {
  errorResponseSchema,
  installedQuerySchema,
  shopifyCallbackQuerySchema,
  shopifyCallbackSuccessSchema,
  shopifyInstallQuerySchema,
  webhookAckSchema,
} from "../../platform/schemas.js";
import {
  handleAppUninstalled,
  handleCustomersDataRequest,
  handleCustomersRedact,
  handleFulfillmentShipment,
  handleInstalledPage,
  handleShopRedact,
  handleShopifyCallback,
  handleShopifyInstall,
} from "./handlers.js";

export const registerShopifyRoutes = (
  app: FastifyInstance,
  { cfg, layer }: RouteContext,
): void => {
  const errorResponses = {
    "4xx": errorResponseSchema,
    "5xx": errorResponseSchema,
  };

  // ---- Shopify install + callback ----
  app.get(
    "/shopify/install",
    {
      schema: {
        tags: ["shopify"],
        summary: "Start the Shopify OAuth install flow",
        querystring: shopifyInstallQuerySchema,
        response: errorResponses,
      },
    },
    async (req, res) => {
      await handleShopifyInstall(cfg, layer, req, res);
      return res;
    },
  );

  app.get(
    "/shopify/auth/callback",
    {
      schema: {
        tags: ["shopify"],
        summary: "Shopify OAuth authorization-code callback",
        querystring: shopifyCallbackQuerySchema,
        response: { 200: shopifyCallbackSuccessSchema, ...errorResponses },
      },
    },
    async (req, res) => {
      await handleShopifyCallback(cfg, layer, req, res);
      return res;
    },
  );

  app.get(
    "/installed",
    {
      schema: {
        tags: ["shopify"],
        summary: "Merchant landing page after a successful install",
        querystring: installedQuerySchema,
      },
    },
    async (req, res) => {
      handleInstalledPage(req, res);
      return res;
    },
  );

  // ---- Shopify lifecycle + compliance webhooks ----
  app.post(
    "/webhooks/shopify/app/uninstalled",
    {
      schema: {
        tags: ["webhooks", "shopify"],
        summary: "Shopify app/uninstalled — revoke the connector",
        response: { 200: webhookAckSchema, ...errorResponses },
      },
    },
    async (req, res) => {
      await handleAppUninstalled(cfg, layer, req, res);
      return res;
    },
  );

  app.post(
    "/webhooks/shopify/fulfillments/create",
    {
      schema: {
        tags: ["webhooks", "shopify"],
        summary: "Shopify fulfillment created — discover shipments",
        response: { 200: webhookAckSchema, ...errorResponses },
      },
    },
    async (req, res) => {
      await handleFulfillmentShipment(cfg, layer, req, res);
      return res;
    },
  );

  app.post(
    "/webhooks/shopify/fulfillments/update",
    {
      schema: {
        tags: ["webhooks", "shopify"],
        summary: "Shopify fulfillment updated — discover shipments",
        response: { 200: webhookAckSchema, ...errorResponses },
      },
    },
    async (req, res) => {
      await handleFulfillmentShipment(cfg, layer, req, res);
      return res;
    },
  );

  app.post(
    "/webhooks/shopify/customers/data_request",
    {
      schema: {
        tags: ["webhooks", "shopify"],
        summary: "Shopify GDPR customers/data_request",
        response: { 200: webhookAckSchema, ...errorResponses },
      },
    },
    async (req, res) => {
      await handleCustomersDataRequest(cfg, layer, req, res);
      return res;
    },
  );

  app.post(
    "/webhooks/shopify/customers/redact",
    {
      schema: {
        tags: ["webhooks", "shopify"],
        summary: "Shopify GDPR customers/redact",
        response: { 200: webhookAckSchema, ...errorResponses },
      },
    },
    async (req, res) => {
      await handleCustomersRedact(cfg, layer, req, res);
      return res;
    },
  );

  app.post(
    "/webhooks/shopify/shop/redact",
    {
      schema: {
        tags: ["webhooks", "shopify"],
        summary: "Shopify GDPR shop/redact",
        response: { 200: webhookAckSchema, ...errorResponses },
      },
    },
    async (req, res) => {
      await handleShopRedact(cfg, layer, req, res);
      return res;
    },
  );
};
