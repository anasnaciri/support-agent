import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../../platform/context.js";
import {
  approvalParamsSchema,
  bundleDecisionParamsSchema,
  bundleReviewParamsSchema,
  tokenQuerySchema,
} from "../../platform/schemas.js";
import {
  handleApprovalConfirmPage,
  handleApprovalDecision,
  handleBundleDecision,
  handleBundleReviewPage,
} from "./handlers.js";

export const registerApprovalRoutes = (
  app: FastifyInstance,
  { cfg, layer }: RouteContext,
): void => {
  // ---- Approval links ----
  // GET verifies the signed link and renders a confirmation page; only
  // the POST (submitted by the page's form) decides. Email-security
  // scanners follow GETs — they must not be able to decide (audit S2).
  app.get(
    "/approvals/:approvalId/:action",
    {
      schema: {
        tags: ["approvals"],
        summary:
          "Confirmation page for an emailed approval link (no state change)",
        params: approvalParamsSchema,
        querystring: tokenQuerySchema,
      },
    },
    async (req, res) => {
      handleApprovalConfirmPage(cfg, req, res);
      return res;
    },
  );
  app.post(
    "/approvals/:approvalId/:action",
    {
      schema: {
        tags: ["approvals"],
        summary: "Approve or reject a gated tool call (confirm-page POST)",
        params: approvalParamsSchema,
      },
    },
    async (req, res) => {
      await handleApprovalDecision(cfg, layer, req, res);
      return res;
    },
  );

  // ---- Bundle review links (queued approvals) ----
  // The autonomous loop parks several gated actions at once; the merchant
  // ping links here. GET lists the whole bundle (no state change — the S2
  // scanner rule applies to Telegram's preview fetcher too); the page's
  // confirm POST decides ALL pending rows and publishes ONE event, same
  // contract as the dashboard bundle buttons. The static `bundle` segment
  // wins over `:approvalId` in the route above, so the paths can coexist.
  app.get(
    "/approvals/bundle/:ticketId",
    {
      schema: {
        tags: ["approvals"],
        summary:
          "Review page for a queued approval bundle (no state change)",
        params: bundleReviewParamsSchema,
        querystring: tokenQuerySchema,
      },
    },
    async (req, res) => {
      await handleBundleReviewPage(cfg, layer, req, res);
      return res;
    },
  );
  app.post(
    "/approvals/bundle/:ticketId/:action",
    {
      schema: {
        tags: ["approvals"],
        summary:
          "Approve or reject the whole queued bundle (confirm-page POST)",
        params: bundleDecisionParamsSchema,
      },
    },
    async (req, res) => {
      await handleBundleDecision(cfg, layer, req, res);
      return res;
    },
  );
};
