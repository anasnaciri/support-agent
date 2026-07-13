import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RbacPermissionId } from "@support-agent/dashboard-contracts";
import { getMemberAccess } from "@support-agent/db";
import { errorResponseSchema } from "../platform/schemas.js";
import type { ApiHandler, RouteContext } from "../platform/context.js";
import type { ApiConfig, ApiLayer } from "../bootstrap.js";
import { sendJson } from "../platform/http.js";
import { authenticateFulfillmentOperator, runWithDb } from "./dashboard-context.js";
import { decideFulfillmentOperatorAuthz } from "./dashboard-authz.js";

/**
 * Centralized fulfillment-operator-endpoint guard. Authenticates, then checks the acting
 * user holds `permission` under the STRICT fulfillmentOperator rules (no open-mode bypass,
 * explicit assignment required — see decideFulfillmentOperatorAuthz). Returns true when the
 * handler should proceed; otherwise it has already sent the error response.
 */
export const enforceFulfillmentOperatorPermission = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
  permission: RbacPermissionId,
): Promise<boolean> => {
  const auth = await authenticateFulfillmentOperator(cfg, layer, req);
  if (!auth.ok) {
    sendJson(res, auth.status, { error: auth.error });
    return false;
  }
  const access = await runWithDb(layer, (db) =>
    getMemberAccess(db, auth.tenantId, auth.userId),
  );
  const decision = decideFulfillmentOperatorAuthz(access, auth.userId, permission);
  if (!decision.ok) {
    sendJson(res, decision.status, { error: decision.error });
    return false;
  }
  return true;
};

/**
 * Build `fulfillmentOperatorGet` / `fulfillmentOperatorPost` bound to one app + context. Unlike the
 * dashboard factory, the permission is REQUIRED — every fulfillmentOperator endpoint is
 * gated on a `fulfillment_operator.tickets.*` permission so the constrained external role can
 * reach these and nothing else (and merchants can't reach them unless granted).
 */
export const makeFulfillmentOperatorRoutes = (app: FastifyInstance, ctx: RouteContext) => {
  const { cfg, layer } = ctx;
  const errorResponses = {
    "4xx": errorResponseSchema,
    "5xx": errorResponseSchema,
  };
  const fulfillmentOperatorJsonResponse = {
    200: { type: "object", additionalProperties: true },
    ...errorResponses,
  };

  const fulfillmentOperatorGet = (
    path: string,
    summary: string,
    handler: ApiHandler,
    permission: RbacPermissionId,
  ): void => {
    app.get(
      path,
      { schema: { tags: ["fulfillment_operator"], summary, response: fulfillmentOperatorJsonResponse } },
      async (req, res) => {
        if (!(await enforceFulfillmentOperatorPermission(cfg, layer, req, res, permission))) {
          return res;
        }
        await handler(cfg, layer, req, res);
        return res;
      },
    );
  };

  // `opts.bodyLimit` raises the per-route cap above the global 1 MiB
  // (attachment uploads).
  const fulfillmentOperatorPost = (
    path: string,
    summary: string,
    handler: ApiHandler,
    permission: RbacPermissionId,
    opts?: { readonly bodyLimit?: number },
  ): void => {
    app.post(
      path,
      {
        schema: { tags: ["fulfillment_operator"], summary },
        ...(opts?.bodyLimit ? { bodyLimit: opts.bodyLimit } : {}),
      },
      async (req, res) => {
        if (!(await enforceFulfillmentOperatorPermission(cfg, layer, req, res, permission))) {
          return res;
        }
        await handler(cfg, layer, req, res);
        return res;
      },
    );
  };

  return { fulfillmentOperatorGet, fulfillmentOperatorPost };
};
