import type { FastifyInstance } from "fastify";
import type { RbacPermissionId } from "@support-agent/dashboard-contracts";
import { errorResponseSchema } from "../platform/schemas.js";
import type { ApiHandler, RouteContext } from "../platform/context.js";
import { enforceDashboardPermission } from "./dashboard-context.js";

/**
 * Build the `dashboardGet` / `dashboardPost` helpers bound to one app + context.
 * Both register a `/dashboard/*` route that, when a `permission` is given, is
 * RBAC-gated: the acting member must hold it (open-mode net handled inside
 * `enforceDashboardPermission`). Omit `permission` for pre-tenant / self-service
 * routes any member may reach. Shared by the dashboard and member-RBAC route
 * modules so the gating pattern lives in exactly one place.
 */
export const makeDashboardRoutes = (app: FastifyInstance, ctx: RouteContext) => {
  const { cfg, layer } = ctx;
  const errorResponses = {
    "4xx": errorResponseSchema,
    "5xx": errorResponseSchema,
  };
  // Reads: object passthrough serializer (discriminated result/Date fields).
  const dashboardJsonResponse = {
    200: { type: "object", additionalProperties: true },
    ...errorResponses,
  };

  const dashboardGet = (
    path: string,
    summary: string,
    handler: ApiHandler,
    permission?: RbacPermissionId,
  ): void => {
    app.get(
      path,
      { schema: { tags: ["dashboard"], summary, response: dashboardJsonResponse } },
      async (req, res) => {
        if (
          permission &&
          !(await enforceDashboardPermission(cfg, layer, req, res, permission))
        ) {
          return res;
        }
        await handler(cfg, layer, req, res);
        return res;
      },
    );
  };

  // Mutations. No response serializer (default JSON.stringify) so the
  // discriminated result/Date fields pass through untouched.
  const dashboardPost = (
    path: string,
    summary: string,
    handler: ApiHandler,
    permission?: RbacPermissionId,
  ): void => {
    app.post(path, { schema: { tags: ["dashboard"], summary } }, async (req, res) => {
      if (
        permission &&
        !(await enforceDashboardPermission(cfg, layer, req, res, permission))
      ) {
        return res;
      }
      await handler(cfg, layer, req, res);
      return res;
    });
  };

  return { dashboardGet, dashboardPost };
};
