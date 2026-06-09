import { Context, Data, Effect } from "effect";

// Abstract boundary for fetching a tenant-supplied URL and turning it into
// readable text (used when a merchant adds a knowledge document "from URL").
// The Live impl (packages/providers) is SSRF-guarded; tests inject a stub.

export type UrlFetchFailureKind =
  | "blocked_scheme" // not http/https
  | "blocked_host" // resolves to a private / loopback / metadata address
  | "too_large" // body exceeded the byte cap
  | "timeout"
  | "too_many_redirects"
  | "http_error" // non-2xx response
  | "no_text" // fetched fine but extraction yielded nothing usable
  | "network"; // DNS / connection failure

export class UrlFetchError extends Data.TaggedError("UrlFetchError")<{
  readonly kind: UrlFetchFailureKind;
  /** Optional context (status code, byte count, blocked-range reason, …). */
  readonly detail?: string;
}> {}

export interface FetchedDocument {
  /** Extracted `<title>`, when present. */
  readonly title: string | null;
  /** Readable text extracted from the page. */
  readonly text: string;
  /** The URL actually fetched (after any redirects). */
  readonly finalUrl: string;
}

export class UrlFetchService extends Context.Tag("UrlFetchService")<
  UrlFetchService,
  {
    readonly fetch: (
      url: string,
    ) => Effect.Effect<FetchedDocument, UrlFetchError>;
  }
>() {}
