import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

// ============================================================
// Response helpers
// ============================================================
//
// Thin wrappers over the Fastify reply API. Each returns the reply so a
// route handler / lifecycle hook can `return sendX(...)` to signal the
// response is handled.

export const sendJson = (
  res: FastifyReply,
  status: number,
  body: unknown,
): FastifyReply => res.code(status).send(body);

/**
 * Log an internal failure cause server-side and return an opaque
 * correlation id for the response body (audit S12). Effect `Cause`
 * stringification can surface stack traces, SQL fragments, and table
 * names — none of which belong in an HTTP response. Ops greps the
 * error id to find the full cause in the logs.
 */
export const opaqueCause = (cause: unknown): string => {
  const errorId = randomUUID().slice(0, 8);
  // eslint-disable-next-line no-console
  console.error(`[api][error_id=${errorId}]`, cause);
  return `error_id=${errorId}`;
};

export const sendRedirect = (res: FastifyReply, target: string): FastifyReply =>
  res.code(302).header("location", target).send();

export const sendRedirectWithHeaders = (
  res: FastifyReply,
  target: string,
  headers: Record<string, string | ReadonlyArray<string>>,
): FastifyReply => {
  for (const [key, value] of Object.entries(headers)) res.header(key, value);
  return res.code(302).header("location", target).send();
};

export const sendText = (
  res: FastifyReply,
  status: number,
  body: string,
): FastifyReply =>
  res.code(status).type("text/plain; charset=utf-8").send(body);

export const sendHtml = (
  res: FastifyReply,
  status: number,
  body: string,
): FastifyReply =>
  res.code(status).type("text/html; charset=utf-8").send(body);

// ============================================================
// Request / query / body helpers
// ============================================================

/** Read a non-empty string query/param value, else undefined. */
export const strField = (
  source: Record<string, unknown>,
  key: string,
): string | undefined => {
  const v = source[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
};

/**
 * Read a repeatable query value as a list. Fastify's parser yields a string for
 * a single key, a string[] for a repeated key, and undefined when absent —
 * normalize all three, dropping empties. Used by the multi-select filters.
 */
export const strList = (
  source: Record<string, unknown>,
  key: string,
): string[] => {
  const v = source[key];
  const arr = Array.isArray(v) ? v : v === undefined ? [] : [v];
  return arr.filter((x): x is string => typeof x === "string" && x.length > 0);
};

/**
 * Parse a JSON request body. The Fastify instance registers a single buffer
 * content-type parser (so webhook HMAC sees raw bytes), so POST handlers must
 * decode JSON themselves. Malformed/empty bodies yield {}.
 */
export const parseJsonBody = (req: FastifyRequest): Record<string, unknown> => {
  const b = req.body as unknown;
  if (!b) return {};
  try {
    const text = Buffer.isBuffer(b)
      ? b.toString("utf8")
      : typeof b === "string"
        ? b
        : "";
    const parsed = text ? JSON.parse(text) : {};
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

/** Read a string body field (reuses strField's non-empty semantics). */
export const bodyStr = (
  req: FastifyRequest,
  key: string,
): string | undefined => strField(parseJsonBody(req), key);

export const readQuery = (
  req: FastifyRequest,
): { url: URL; params: Record<string, string> } => {
  // The Host header is trusted only for *parsing* the path — we never echo
  // it back to the client. For URL construction we use a placeholder that
  // makes `new URL(...)` happy.
  const u = new URL(req.url ?? "/", "http://placeholder");
  const params: Record<string, string> = {};
  for (const [k, v] of u.searchParams) params[k] = v;
  return { url: u, params };
};

export const parseCookies = (
  raw: string | undefined,
): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
};

// ============================================================
// HTML / cookie helpers
// ============================================================

/** HTML-entity escape for values interpolated into HTML pages (audit S5). */
export const escapeHtml = (s: string): string =>
  s
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");

export const SHOPIFY_INSTALL_COOKIE = "support_agent_shopify_install";

export const shopifyInstallCookie = (state: string, secure: boolean): string =>
  `${SHOPIFY_INSTALL_COOKIE}=${encodeURIComponent(state)}; Path=/shopify/install; Max-Age=600; HttpOnly; SameSite=Lax${
    secure ? "; Secure" : ""
  }`;

export const clearShopifyInstallCookie = (secure: boolean): string =>
  `${SHOPIFY_INSTALL_COOKIE}=; Path=/shopify/install; Max-Age=0; HttpOnly; SameSite=Lax${
    secure ? "; Secure" : ""
  }`;
