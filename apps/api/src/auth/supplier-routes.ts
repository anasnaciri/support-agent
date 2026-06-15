import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RbacPermissionId } from "@support-agent/dashboard-contracts";
import { getMemberAccess } from "@support-agent/db";
import { errorResponseSchema } from "../platform/schemas.js";
import type { ApiHandler, RouteContext } from "../platform/context.js";
import type { ApiConfig, ApiLayer } from "../bootstrap.js";
import { sendJson } from "../platform/http.js";
import { authenticateDashboard, runWithDb } from "./dashboard-context.js";
import { decideSupplierAuthz } from "./dashboard-authz.js";

/**
 * Centralized supplier-endpoint guard. Authenticates, then checks the acting
 * user holds `permission` under the STRICT supplier rules (no open-mode bypass,
 * explicit assignment required — see decideSupplierAuthz). Returns true when the
 * handler should proceed; otherwise it has already sent the error response.
 */
export const enforceSupplierPermission = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
  permission: RbacPermissionId,
): Promise<boolean> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) {
    sendJson(res, auth.status, { error: auth.error });
    return false;
  }
  const access = await runWithDb(layer, (db) =>
    getMemberAccess(db, auth.tenantId, auth.userId),
  );
  const decision = decideSupplierAuthz(access, auth.userId, permission);
  if (!decision.ok) {
    sendJson(res, decision.status, { error: decision.error });
    return false;
  }
  return true;
};

/**
 * Build `supplierGet` / `supplierPost` bound to one app + context. Unlike the
 * dashboard factory, the permission is REQUIRED — every supplier endpoint is
 * gated on a `supplier.cases.*` permission so the constrained external role can
 * reach these and nothing else (and merchants can't reach them unless granted).
 */
export const makeSupplierRoutes = (app: FastifyInstance, ctx: RouteContext) => {
  const { cfg, layer } = ctx;
  const errorResponses = {
    "4xx": errorResponseSchema,
    "5xx": errorResponseSchema,
  };
  const supplierJsonResponse = {
    200: { type: "object", additionalProperties: true },
    ...errorResponses,
  };

  const supplierGet = (
    path: string,
    summary: string,
    handler: ApiHandler,
    permission: RbacPermissionId,
  ): void => {
    app.get(
      path,
      { schema: { tags: ["supplier"], summary, response: supplierJsonResponse } },
      async (req, res) => {
        if (!(await enforceSupplierPermission(cfg, layer, req, res, permission))) {
          return res;
        }
        await handler(cfg, layer, req, res);
        return res;
      },
    );
  };

  const supplierPost = (
    path: string,
    summary: string,
    handler: ApiHandler,
    permission: RbacPermissionId,
  ): void => {
    app.post(path, { schema: { tags: ["supplier"], summary } }, async (req, res) => {
      if (!(await enforceSupplierPermission(cfg, layer, req, res, permission))) {
        return res;
      }
      await handler(cfg, layer, req, res);
      return res;
    });
  };

  return { supplierGet, supplierPost };
};
