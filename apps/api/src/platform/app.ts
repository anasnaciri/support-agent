import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyRequest,
} from "fastify";
import fastifyHelmet from "@fastify/helmet";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyCors, {
  type FastifyCorsOptions,
} from "@fastify/cors";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { loggerConfig } from "./logger.js";
import { sendJson } from "./http.js";
import { TAGS } from "./schemas.js";
import type { DashboardTokenVerifier } from "../auth/dashboard-jwt.js";
import { csrfRejected, type SessionCodec } from "../auth/dashboard-session.js";
import type {
  WorkosOrgAdminDirectory,
  WorkosOrganizationDirectory,
  WorkosUserDirectory,
} from "../auth/workos-directory.js";

export interface AppDecorations {
  readonly dashboardTokenVerifier: DashboardTokenVerifier | null;
  readonly workosUserDirectory: WorkosUserDirectory | null;
  readonly workosOrganizationDirectory: WorkosOrganizationDirectory | null;
  readonly workosOrgAdminDirectory: WorkosOrgAdminDirectory | null;
  /**
   * SPA BFF session codec (seal/unseal the httpOnly cookie). `null` when the
   * BFF isn't configured — the cookie credential is then unavailable and only
   * the Bearer path works. Read off `req.server` by the auth seam.
   */
  readonly dashboardSessionCodec: SessionCodec | null;
  /**
   * Allowed SPA origins for the `/dashboard/*` CORS allowlist + the cookie-path
   * CSRF origin check. Empty when the BFF isn't configured (CORS stays closed).
   */
  readonly dashboardBffOrigins: ReadonlyArray<string>;
}

/**
 * Build the Fastify instance with every cross-cutting concern wired but no
 * routes yet: logging, the raw-body content-type parser (webhook HMAC), the
 * WorkOS decorations, security headers, rate limiting, OpenAPI, and the
 * error/not-found handlers. The composition root registers feature routes on
 * the returned app, then calls `listen`. Swagger is registered here (before
 * routes) so its onRoute hook captures every schema added afterwards.
 */
export const buildApp = async (
  decorations: AppDecorations,
): Promise<FastifyInstance> => {
  const app: FastifyInstance = Fastify({
    logger: loggerConfig(),
    // Matches the old readRawBody cap. Shopify/Pub/Sub payloads are tiny;
    // anything near the cap is suspect and fails closed with 413.
    bodyLimit: 1024 * 1024,
  });
  app.decorate("dashboardTokenVerifier", decorations.dashboardTokenVerifier);
  app.decorate("workosUserDirectory", decorations.workosUserDirectory);
  app.decorate(
    "workosOrganizationDirectory",
    decorations.workosOrganizationDirectory,
  );
  app.decorate(
    "workosOrgAdminDirectory",
    decorations.workosOrgAdminDirectory,
  );
  app.decorate("dashboardSessionCodec", decorations.dashboardSessionCodec);

  // Webhook HMAC is computed over the exact bytes the provider sent, so we
  // keep the raw body as a Buffer instead of letting Fastify JSON-parse it
  // (which would change whitespace/key order and break the signature).
  // Handlers JSON-parse afterwards. We drop the built-in parsers first —
  // otherwise Fastify's `application/json` parser (more specific than `*`)
  // would still hand handlers a parsed object for Shopify + Pub/Sub
  // payloads. With them gone, the catch-all buffers every content type.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    "*",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );

  // Security headers (audit S11). The CSP is strict because the only HTML
  // this server emits is self-contained receipt/landing pages with inline
  // styles — no scripts, no external assets.
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        styleSrc: ["'unsafe-inline'"],
        formAction: ["'self'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  });

  // CORS is closed everywhere EXCEPT `/dashboard/*` from the allow-listed SPA
  // origin(s) (dashboard-spa BFF). Webhooks/OAuth/admin stay browser-closed —
  // the Next dashboard talks server-to-server with a bearer and needs no CORS.
  // The delegator returns `{ origin: false }` for anything off the allowlist.
  const allowedOrigins = new Set(decorations.dashboardBffOrigins);
  const hstr = (v: string | string[] | undefined): string | undefined =>
    Array.isArray(v) ? v[0] : v;
  if (allowedOrigins.size > 0) {
    await app.register(fastifyCors, () => (
      req: FastifyRequest,
      cb: (err: Error | null, options: FastifyCorsOptions) => void,
    ) => {
      const origin = hstr(req.headers.origin);
      if (
        (req.url ?? "").startsWith("/dashboard/") &&
        origin &&
        allowedOrigins.has(origin)
      ) {
        cb(null, {
          origin,
          credentials: true,
          methods: ["GET", "POST", "OPTIONS"],
          allowedHeaders: ["content-type", "x-workspace-id"],
          maxAge: 600,
        });
      } else {
        cb(null, { origin: false });
      }
    });

    // CSRF: a cookie-authed `/dashboard/*` mutation must carry an allowed Origin
    // (the SPA cookie is SameSite=None cross-site, so ambient-cookie CSRF is
    // otherwise possible). Bearer + safe-method + non-dashboard requests skip it.
    app.addHook("onRequest", async (req, res) => {
      if (
        csrfRejected({
          url: req.url ?? "",
          method: req.method,
          cookieHeader: hstr(req.headers.cookie),
          authorizationHeader: hstr(req.headers.authorization),
          origin: hstr(req.headers.origin),
          allowedOrigins,
        })
      ) {
        return sendJson(res, 403, { error: "csrf_origin_rejected" });
      }
    });
  }

  // Rate limiting (audit S11). One generous global bucket — the goal is
  // blunting token brute-force and webhook floods, not traffic shaping.
  // Keyed by IP; the worker/dashboard talk to Postgres or use one bearer
  // token from a handful of IPs, so legitimate traffic never approaches
  // this. Disabled under tests to keep suites deterministic.
  if (process.env["NODE_ENV"] !== "test") {
    await app.register(fastifyRateLimit, {
      max: Number(process.env["RATE_LIMIT_MAX"] ?? 600),
      timeWindow: "1 minute",
    });
  }

  // OpenAPI generation. Registered before the routes so its onRoute hook
  // captures every schema below; the browsable UI lands at /docs.
  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "support-agent API",
        description:
          "Webhook, OAuth install/callback, and approval-link edge for the support-agent runtime.",
        version: "0.0.0",
      },
      tags: TAGS,
    },
  });
  await app.register(fastifySwaggerUi, { routePrefix: "/docs" });

  app.setNotFoundHandler((_req, res) =>
    sendJson(res, 404, { error: "not_found" }),
  );

  app.setErrorHandler((err: FastifyError, req, res) => {
    const statusCode = err.statusCode ?? 500;
    if (statusCode === 413) {
      return sendJson(res, 413, {
        error: "body_too_large_or_unreadable",
        detail: err.message,
      });
    }
    if (err.validation) {
      return sendJson(res, 400, {
        error: "validation_failed",
        detail: err.message,
      });
    }
    req.log.error({ err }, "[api] unhandled error");
    return sendJson(res, 500, { error: "internal" });
  });

  return app;
};
