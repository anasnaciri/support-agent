import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../../platform/context.js";
import { approvalParamsSchema, tokenQuerySchema } from "../../platform/schemas.js";
import { handleApprovalConfirmPage, handleApprovalDecision } from "./handlers.js";

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
};
