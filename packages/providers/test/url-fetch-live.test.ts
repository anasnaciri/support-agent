import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { UrlFetchError } from "@support-agent/services";
import { makeUrlFetchService } from "../src/url-fetch-live.js";

const publicLookup = async () => [{ address: "93.184.216.34" }];

const failKind = async (
  svc: ReturnType<typeof makeUrlFetchService>,
  url: string,
): Promise<string> => {
  const err = await Effect.runPromise(Effect.flip(svc.fetch(url)));
  return (err as UrlFetchError).kind;
};

describe("makeUrlFetchService", () => {
  it("fetches, extracts title + readable text, and reports the final URL", async () => {
    const svc = makeUrlFetchService({
      lookupImpl: publicLookup,
      fetchImpl: async () =>
        new Response(
          "<html><title>Shipping</title><body><p>Ships in 3 days</p></body></html>",
          { status: 200 },
        ),
    });
    const doc = await Effect.runPromise(svc.fetch("https://shop.example/ship"));
    expect(doc.title).toBe("Shipping");
    expect(doc.text).toContain("Ships in 3 days");
    expect(doc.finalUrl).toBe("https://shop.example/ship");
  });

  it("rejects a non-http(s) scheme without touching the network", async () => {
    let fetched = false;
    let resolved = false;
    const svc = makeUrlFetchService({
      lookupImpl: async () => {
        resolved = true;
        return [{ address: "93.184.216.34" }];
      },
      fetchImpl: async () => {
        fetched = true;
        return new Response("x");
      },
    });
    expect(await failKind(svc, "ftp://shop.example/policy")).toBe(
      "blocked_scheme",
    );
    expect(fetched).toBe(false);
    expect(resolved).toBe(false);
  });

  it("blocks a host that resolves to a private address (no fetch)", async () => {
    let fetched = false;
    const svc = makeUrlFetchService({
      lookupImpl: async () => [{ address: "127.0.0.1" }],
      fetchImpl: async () => {
        fetched = true;
        return new Response("secret");
      },
    });
    expect(await failKind(svc, "https://evil.example/")).toBe("blocked_host");
    expect(fetched).toBe(false);
  });

  it("blocks an IP-literal private host without a DNS lookup", async () => {
    let resolved = false;
    const svc = makeUrlFetchService({
      lookupImpl: async () => {
        resolved = true;
        return [{ address: "1.1.1.1" }];
      },
      fetchImpl: async () => new Response("x"),
    });
    expect(await failKind(svc, "http://169.254.169.254/latest/meta-data")).toBe(
      "blocked_host",
    );
    expect(resolved).toBe(false);
  });

  it("follows a redirect and re-validates the next hop", async () => {
    const svc = makeUrlFetchService({
      lookupImpl: publicLookup,
      fetchImpl: async (input) => {
        const u = String(input);
        if (u.includes("/start")) {
          return new Response(null, {
            status: 302,
            headers: { location: "https://shop.example/end" },
          });
        }
        return new Response("<p>Arrived</p>", { status: 200 });
      },
    });
    const doc = await Effect.runPromise(svc.fetch("https://shop.example/start"));
    expect(doc.text).toContain("Arrived");
    expect(doc.finalUrl).toBe("https://shop.example/end");
  });

  it("gives up after too many redirects", async () => {
    const svc = makeUrlFetchService({
      lookupImpl: publicLookup,
      maxRedirects: 2,
      fetchImpl: async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://shop.example/loop" },
        }),
    });
    expect(await failKind(svc, "https://shop.example/loop")).toBe(
      "too_many_redirects",
    );
  });

  it("rejects an oversized body", async () => {
    const svc = makeUrlFetchService({
      lookupImpl: publicLookup,
      maxBytes: 1000,
      fetchImpl: async () => new Response("x".repeat(5000), { status: 200 }),
    });
    expect(await failKind(svc, "https://shop.example/big")).toBe("too_large");
  });

  it("maps a non-2xx response to http_error", async () => {
    const svc = makeUrlFetchService({
      lookupImpl: publicLookup,
      fetchImpl: async () => new Response("nope", { status: 404 }),
    });
    expect(await failKind(svc, "https://shop.example/missing")).toBe(
      "http_error",
    );
  });

  it("maps an empty page to no_text", async () => {
    const svc = makeUrlFetchService({
      lookupImpl: publicLookup,
      fetchImpl: async () =>
        new Response("<html><body></body></html>", { status: 200 }),
    });
    expect(await failKind(svc, "https://shop.example/blank")).toBe("no_text");
  });
});
