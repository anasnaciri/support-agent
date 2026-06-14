import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../../platform/context.js";
import { sendHtml, sendText } from "../../platform/http.js";
import { renderDataProcessingNoticeHtml } from "./legal.js";

// System routes need neither cfg nor layer; ctx is accepted for a uniform
// registrar signature.
export const registerSystemRoutes = (
  app: FastifyInstance,
  _ctx: RouteContext,
): void => {
  // ---- System ----
  app.get(
    "/legal/data-processing",
    {
      schema: {
        tags: ["system"],
        summary: "Public data processing notice and DPA",
      },
    },
    async (_req, res) => sendHtml(res, 200, renderDataProcessingNoticeHtml()),
  );

  app.get(
    "/healthz",
    { schema: { tags: ["system"], summary: "Liveness probe" } },
    async (_req, res) => sendText(res, 200, "ok"),
  );

  app.get(
    "/openapi.json",
    { schema: { tags: ["system"], summary: "OpenAPI document", hide: true } },
    async () => app.swagger(),
  );
};
