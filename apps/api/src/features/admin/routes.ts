import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../../platform/context.js";
import {
  handleAdminAccountDetail,
  handleAdminAccountOpenRouterDelete,
  handleAdminAccountOpenRouterPut,
  handleAdminShopifyAppDelete,
  handleAdminShopifyAppGet,
  handleAdminShopifyAppPcdCheck,
  handleAdminShopifyAppPut,
  handleAdminTenantDelete,
  handleAdminTenantDetail,
  handleAdminTenantsList,
  handleAdminWorkspaceOpenRouterDelete,
  handleAdminWorkspaceOpenRouterPut,
} from "./account-handlers.js";

export const registerAdminRoutes = (
  app: FastifyInstance,
  { cfg, layer }: RouteContext,
): void => {
  // ---- Admin (platform operator) ----
  app.post(
    "/admin/tenants/:id/delete",
    {
      schema: {
        tags: ["admin"],
        summary: "Delete any tenant's account (platform operator)",
      },
    },
    async (req, res) => {
      await handleAdminTenantDelete(cfg, layer, req, res);
      return res;
    },
  );
  app.get(
    "/admin/tenants",
    { schema: { tags: ["admin"], summary: "List all tenants (platform operator)" } },
    async (req, res) => {
      await handleAdminTenantsList(cfg, layer, req, res);
      return res;
    },
  );
  app.get(
    "/admin/tenants/:id",
    {
      schema: {
        tags: ["admin"],
        summary: "Tenant detail: Shopify app + connector health (operator)",
      },
    },
    async (req, res) => {
      await handleAdminTenantDetail(cfg, layer, req, res);
      return res;
    },
  );
  app.get(
    "/admin/accounts/:organizationId",
    {
      schema: {
        tags: ["admin"],
        summary: "Account workspaces + inherited OpenRouter status (operator)",
      },
    },
    async (req, res) => {
      await handleAdminAccountDetail(cfg, layer, req, res);
      return res;
    },
  );
  app.put(
    "/admin/accounts/:organizationId/openrouter",
    {
      schema: {
        tags: ["admin"],
        summary: "Set the inherited account OpenRouter key (operator)",
      },
    },
    async (req, res) => {
      await handleAdminAccountOpenRouterPut(cfg, layer, req, res);
      return res;
    },
  );
  app.delete(
    "/admin/accounts/:organizationId/openrouter",
    {
      schema: {
        tags: ["admin"],
        summary: "Revoke the inherited account OpenRouter key (operator)",
      },
    },
    async (req, res) => {
      await handleAdminAccountOpenRouterDelete(cfg, layer, req, res);
      return res;
    },
  );
  app.put(
    "/admin/tenants/:id/openrouter",
    {
      schema: {
        tags: ["admin"],
        summary: "Set a workspace OpenRouter override (operator)",
      },
    },
    async (req, res) => {
      await handleAdminWorkspaceOpenRouterPut(cfg, layer, req, res);
      return res;
    },
  );
  app.delete(
    "/admin/tenants/:id/openrouter",
    {
      schema: {
        tags: ["admin"],
        summary: "Revoke a workspace LLM override (operator)",
      },
    },
    async (req, res) => {
      await handleAdminWorkspaceOpenRouterDelete(cfg, layer, req, res);
      return res;
    },
  );
  app.put(
    "/admin/tenants/:id/shopify-app",
    {
      schema: {
        tags: ["admin"],
        summary: "Provision a tenant's Shopify custom app (client_id + secret)",
      },
    },
    async (req, res) => {
      await handleAdminShopifyAppPut(cfg, layer, req, res);
      return res;
    },
  );
  app.get(
    "/admin/tenants/:id/shopify-app",
    {
      schema: {
        tags: ["admin"],
        summary: "Read a tenant's Shopify app provisioning (never the secret)",
      },
    },
    async (req, res) => {
      await handleAdminShopifyAppGet(cfg, layer, req, res);
      return res;
    },
  );
  app.delete(
    "/admin/tenants/:id/shopify-app",
    {
      schema: {
        tags: ["admin"],
        summary: "Revoke a tenant's Shopify app provisioning",
      },
    },
    async (req, res) => {
      await handleAdminShopifyAppDelete(cfg, layer, req, res);
      return res;
    },
  );
  app.post(
    "/admin/tenants/:id/shopify-app/pcd-check",
    {
      schema: {
        tags: ["admin"],
        summary:
          "Probe whether the connected store returns protected customer data",
      },
    },
    async (req, res) => {
      await handleAdminShopifyAppPcdCheck(cfg, layer, req, res);
      return res;
    },
  );
};
