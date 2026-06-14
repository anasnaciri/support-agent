// Pino logger configuration + request-URL secret redaction for the api server.
// Extracted from server.ts so the composition root stays focused on wiring.

/**
 * Strip secret-bearing query params from a URL before it reaches the
 * request log (audit S6). Several capability secrets travel in `?…`:
 * the Gmail push token, signed approval tokens, and install grants —
 * anyone with log access could previously harvest them.
 */
const SECRET_QUERY_PARAMS = ["token", "grant", "code", "id_token", "hmac"];

export const redactUrlSecrets = (url: string): string => {
  const q = url.indexOf("?");
  if (q === -1) return url;
  try {
    const params = new URLSearchParams(url.slice(q + 1));
    let touched = false;
    for (const name of SECRET_QUERY_PARAMS) {
      if (params.has(name)) {
        params.set(name, "[redacted]");
        touched = true;
      }
    }
    if (!touched) return url;
    return `${url.slice(0, q)}?${params.toString()}`;
  } catch {
    // Unparseable query string — drop it entirely rather than log it.
    return url.slice(0, q);
  }
};

/**
 * Pino logger config. Enabled by default (structured JSON); quieted to
 * `warn` under tests so the DB-gated integration suite isn't drowned in
 * per-request lines. `LOG_LEVEL` overrides the level outside tests.
 * The request serializer redacts secret query params (audit S6) and the
 * `redact` paths cover headers that may carry bearer tokens.
 */
export const loggerConfig = () => ({
  level:
    process.env["NODE_ENV"] === "test"
      ? "warn"
      : (process.env["LOG_LEVEL"] ?? "info"),
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers['x-goog-channel-token']",
    ],
    censor: "[redacted]",
  },
  serializers: {
    req: (req: { method: string; url: string }) => ({
      method: req.method,
      url: redactUrlSecrets(req.url ?? ""),
    }),
  },
});
