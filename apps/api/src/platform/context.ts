import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ApiConfig, ApiLayer } from "../bootstrap.js";

/**
 * The shared dependencies every route handler needs: the resolved config and
 * the built Effect layer. Built once in the composition root and threaded to
 * each feature's `register*Routes(app, ctx)`. The WorkOS verifiers are read off
 * `req.server` (decorated at app build) rather than carried here.
 */
export interface RouteContext {
  readonly cfg: ApiConfig;
  readonly layer: ApiLayer;
}

/** A handler the route layer adapts to Fastify: `(cfg, layer, req, res)`. */
export type ApiHandler = (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
) => Promise<FastifyReply>;

/** One feature's route registrar, mounted from the composition root. */
export type RouteRegistrar = (app: FastifyInstance, ctx: RouteContext) => void;
