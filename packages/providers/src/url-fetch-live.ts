import { Effect, Layer } from "effect";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import {
  UrlFetchError,
  UrlFetchService,
  type FetchedDocument,
} from "@support-agent/services";
import {
  blockedIpReason,
  isAllowedScheme,
  isIpLiteral,
} from "./url-fetch-ssrf.js";
import { extractTitle, htmlToText } from "./url-fetch-html.js";

// SSRF-guarded fetch of a tenant-supplied URL → readable text. The guard runs
// on EVERY hop (initial + each redirect): scheme allow-list, then DNS-resolve
// the host ONCE, reject if ANY resolved address is non-public, and PIN the
// connection to that validated set — the transport never consults DNS again,
// so a rebinding second answer (public IP for the check, 169.254.169.254 for
// the connect) has nothing to poison. The original hostname is kept for the
// Host header and TLS SNI. Bounded by a redirect cap, request timeout, and
// response byte cap.

export type LookupImpl = (
  host: string,
) => Promise<ReadonlyArray<{ readonly address: string; readonly family?: number }>>;

/** A DNS answer that passed validation and is safe to connect to. */
export interface PinnedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/**
 * Builds the transport for one hop, pinned to the already-validated
 * addresses. The default is {@link makePinnedFetch}; tests inject a spy to
 * prove the connection uses exactly what was validated.
 */
export type PinnedFetchFactory = (
  addresses: ReadonlyArray<PinnedAddress>,
) => typeof fetch;

export interface UrlFetchConfig {
  /** Test seam: replaces the network entirely (no pinning involved). */
  readonly fetchImpl?: typeof fetch;
  /** Transport factory receiving the validated addresses for each hop. */
  readonly pinnedFetchFactory?: PinnedFetchFactory;
  readonly lookupImpl?: LookupImpl;
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
  readonly timeoutMs?: number;
  readonly userAgent?: string;
}

const DEFAULT_MAX_BYTES = 2_000_000;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_UA = "support-agent-knowledge-fetch/1.0";

const defaultLookup: LookupImpl = async (host) => {
  const res = await lookup(host, { all: true });
  return res.map((r) => ({ address: r.address, family: r.family }));
};

const toPinned = (address: string): PinnedAddress | null => {
  const family = isIP(address);
  return family === 4 || family === 6 ? { address, family } : null;
};

const stripBrackets = (host: string): string => host.replace(/^\[|\]$/g, "");

/**
 * Resolve `host` once and validate every answer; the returned set is what the
 * connection MUST be pinned to. Throws unless every resolved address is
 * publicly routable.
 */
const resolvePublicAddresses = async (
  host: string,
  lookupImpl: LookupImpl,
): Promise<ReadonlyArray<PinnedAddress>> => {
  if (isIpLiteral(host)) {
    const reason = blockedIpReason(host);
    if (reason) throw new UrlFetchError({ kind: "blocked_host", detail: reason });
    const pinned = toPinned(stripBrackets(host));
    if (!pinned) {
      throw new UrlFetchError({ kind: "blocked_host", detail: "unparseable" });
    }
    return [pinned];
  }
  let addresses: Awaited<ReturnType<LookupImpl>>;
  try {
    addresses = await lookupImpl(host);
  } catch {
    throw new UrlFetchError({ kind: "network", detail: "dns_failed" });
  }
  if (addresses.length === 0) {
    throw new UrlFetchError({ kind: "network", detail: "no_address" });
  }
  const pinned: Array<PinnedAddress> = [];
  for (const a of addresses) {
    const reason = blockedIpReason(a.address);
    if (reason) throw new UrlFetchError({ kind: "blocked_host", detail: reason });
    const p = toPinned(a.address);
    if (!p) {
      throw new UrlFetchError({ kind: "blocked_host", detail: "unparseable" });
    }
    pinned.push(p);
  }
  return pinned;
};

// ============================================================
// Pinned transport — connects to the validated addresses only
// ============================================================

/**
 * A node-style `lookup` that answers from the validated set without ever
 * consulting DNS — this is the pin. Handles both the `all: true` and
 * single-address callback shapes `net.connect` uses.
 */
const makePinnedLookup = (
  addresses: ReadonlyArray<PinnedAddress>,
): LookupFunction =>
  ((
    _hostname: string,
    options: { all?: boolean } | ((...args: Array<never>) => void),
    callback?: (
      err: NodeJS.ErrnoException | null,
      address: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void,
  ): void => {
    const cb = (typeof options === "function" ? options : callback) as (
      err: NodeJS.ErrnoException | null,
      address: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void;
    const all = typeof options === "object" && options.all === true;
    const first = addresses[0]!;
    if (all) {
      cb(
        null,
        addresses.map((a) => ({ address: a.address, family: a.family })),
      );
    } else {
      cb(null, first.address, first.family);
    }
  }) as unknown as LookupFunction;

/**
 * Minimal `fetch`-shaped transport over node:http(s) whose connection is
 * pinned to the validated addresses: the URL (and therefore the Host header
 * and TLS servername) keeps the original hostname, while the socket's
 * `lookup` is replaced by {@link makePinnedLookup}. Never follows redirects.
 * Exported for tests.
 */
export const makePinnedFetch =
  (addresses: ReadonlyArray<PinnedAddress>): typeof fetch =>
  (input, init) =>
    new Promise<Response>((resolve, reject) => {
      let url: URL;
      try {
        url = new URL(
          typeof input === "object" && "url" in input ? input.url : String(input),
        );
      } catch (cause) {
        reject(cause);
        return;
      }
      const isHttps = url.protocol === "https:";
      const request = isHttps ? httpsRequest : httpRequest;
      const hostname = stripBrackets(url.hostname);
      const headers: Record<string, string> = { host: url.host };
      if (init?.headers) {
        for (const [k, v] of Object.entries(
          init.headers as Record<string, string>,
        )) {
          headers[k.toLowerCase()] = v;
        }
      }
      const req = request(
        {
          protocol: url.protocol,
          hostname,
          port: url.port !== "" ? Number(url.port) : isHttps ? 443 : 80,
          path: `${url.pathname}${url.search}`,
          method: init?.method ?? "GET",
          headers,
          lookup: makePinnedLookup(addresses),
          // One connection per request — no keep-alive pool that could pair a
          // later request with a socket pinned for an earlier validation.
          agent: false,
          // SNI must stay the hostname (cert validation), never the IP.
          ...(isHttps && isIP(hostname) === 0 ? { servername: hostname } : {}),
          ...(init?.signal ? { signal: init.signal } : {}),
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const resHeaders = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) {
              for (const item of v) resHeaders.append(k, item);
            } else if (typeof v === "string") {
              resHeaders.set(k, v);
            }
          }
          const body =
            status === 204 || status === 205 || status === 304
              ? null
              : (Readable.toWeb(res) as unknown as ConstructorParameters<
                  typeof Response
                >[0]);
          try {
            resolve(new Response(body, { status, headers: resHeaders }));
          } catch (cause) {
            res.resume();
            reject(cause);
          }
        },
      );
      req.on("error", reject);
      req.end();
    });

const doFetch = async (
  url: URL,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  userAgent: string,
): Promise<Response> => {
  try {
    return await fetchImpl(url.toString(), {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "user-agent": userAgent,
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
      },
    });
  } catch (cause) {
    const name =
      cause && typeof cause === "object" && "name" in cause
        ? String((cause as { name: unknown }).name)
        : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new UrlFetchError({ kind: "timeout" });
    }
    throw new UrlFetchError({ kind: "network", detail: String(cause) });
  }
};

const readCapped = async (res: Response, maxBytes: number): Promise<string> => {
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    if (text.length > maxBytes) {
      throw new UrlFetchError({ kind: "too_large", detail: String(text.length) });
    }
    return text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new UrlFetchError({ kind: "too_large", detail: String(total) });
      }
      chunks.push(value);
    }
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder("utf-8").decode(buf);
};

const discardBody = async (res: Response): Promise<void> => {
  try {
    await res.body?.cancel();
  } catch {
    // Already-consumed / locked bodies are fine to leave behind.
  }
};

const fetchReadable = async (
  rawUrl: string,
  cfg: UrlFetchConfig,
): Promise<FetchedDocument> => {
  // Precedence: an explicit pinned-factory (the production path and the
  // pinning tests) over the legacy whole-network fake, over the real
  // pinned transport.
  const pinnedFetchFactory: PinnedFetchFactory =
    cfg.pinnedFetchFactory ??
    (cfg.fetchImpl ? () => cfg.fetchImpl! : makePinnedFetch);
  const lookupImpl = cfg.lookupImpl ?? defaultLookup;
  const maxBytes = cfg.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = cfg.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const userAgent = cfg.userAgent ?? DEFAULT_UA;

  let currentUrl = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let url: URL;
    try {
      url = new URL(currentUrl);
    } catch {
      throw new UrlFetchError({ kind: "blocked_scheme", detail: "invalid_url" });
    }
    if (!isAllowedScheme(url)) {
      throw new UrlFetchError({ kind: "blocked_scheme", detail: url.protocol });
    }
    // Resolve + validate ONCE, then pin the hop's connection to that result.
    const pinned = await resolvePublicAddresses(url.hostname, lookupImpl);

    const res = await doFetch(url, pinnedFetchFactory(pinned), timeoutMs, userAgent);

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await discardBody(res);
      if (!location) {
        throw new UrlFetchError({ kind: "http_error", detail: String(res.status) });
      }
      currentUrl = new URL(location, url).toString();
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      await discardBody(res);
      throw new UrlFetchError({ kind: "http_error", detail: String(res.status) });
    }

    const html = await readCapped(res, maxBytes);
    const text = htmlToText(html);
    if (text.length === 0) {
      throw new UrlFetchError({ kind: "no_text" });
    }
    return { title: extractTitle(html), text, finalUrl: url.toString() };
  }
  throw new UrlFetchError({ kind: "too_many_redirects" });
};

export const makeUrlFetchService = (cfg: UrlFetchConfig = {}) =>
  UrlFetchService.of({
    fetch: (url: string) =>
      Effect.tryPromise({
        try: () => fetchReadable(url, cfg),
        catch: (cause) =>
          cause instanceof UrlFetchError
            ? cause
            : new UrlFetchError({ kind: "network", detail: String(cause) }),
      }),
  });

export const UrlFetchServiceLive = Layer.succeed(
  UrlFetchService,
  makeUrlFetchService(),
);
