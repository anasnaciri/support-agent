import { Effect, Layer } from "effect";
import { lookup } from "node:dns/promises";
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
// the host and reject if ANY resolved address is non-public (closes the
// DNS-rebind window where a public name points at 127.0.0.1). Bounded by a
// redirect cap, request timeout, and response byte cap.

export type LookupImpl = (
  host: string,
) => Promise<ReadonlyArray<{ readonly address: string }>>;

export interface UrlFetchConfig {
  readonly fetchImpl?: typeof fetch;
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
  return res.map((r) => ({ address: r.address }));
};

/** Reject the host unless every resolved address is publicly routable. */
const assertPublicHost = async (
  host: string,
  lookupImpl: LookupImpl,
): Promise<void> => {
  if (isIpLiteral(host)) {
    const reason = blockedIpReason(host);
    if (reason) throw new UrlFetchError({ kind: "blocked_host", detail: reason });
    return;
  }
  let addresses: ReadonlyArray<{ address: string }>;
  try {
    addresses = await lookupImpl(host);
  } catch {
    throw new UrlFetchError({ kind: "network", detail: "dns_failed" });
  }
  if (addresses.length === 0) {
    throw new UrlFetchError({ kind: "network", detail: "no_address" });
  }
  for (const a of addresses) {
    const reason = blockedIpReason(a.address);
    if (reason) throw new UrlFetchError({ kind: "blocked_host", detail: reason });
  }
};

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

const fetchReadable = async (
  rawUrl: string,
  cfg: UrlFetchConfig,
): Promise<FetchedDocument> => {
  const fetchImpl = cfg.fetchImpl ?? fetch;
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
    await assertPublicHost(url.hostname, lookupImpl);

    const res = await doFetch(url, fetchImpl, timeoutMs, userAgent);

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) {
        throw new UrlFetchError({ kind: "http_error", detail: String(res.status) });
      }
      currentUrl = new URL(location, url).toString();
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
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
