import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { UrlFetchError } from "@support-agent/services";
import {
  makePinnedFetch,
  makeUrlFetchService,
  type PinnedAddress,
} from "../src/url-fetch-live.js";

// S1 — DNS rebinding. Validating a hostname with one lookup and then letting
// the HTTP client re-resolve independently lets an attacker answer with a
// public IP for the check and 169.254.169.254 for the connect. The fix pins:
// resolve once, validate every address, then hand the validated set to the
// transport (which must never consult DNS again). Re-pinned on every
// redirect hop.

const html = (s: string) => new Response(`<p>${s}</p>`, { status: 200 });

describe("makeUrlFetchService pinning", () => {
  it("connects with the validated addresses — a rebinding second DNS answer is never consulted", async () => {
    const answers: Array<ReadonlyArray<{ address: string }>> = [
      [{ address: "93.184.216.34" }],
      [{ address: "169.254.169.254" }], // the rebind — must never be used
    ];
    let lookups = 0;
    const factoryCalls: Array<ReadonlyArray<PinnedAddress>> = [];
    const fetchedUrls: Array<string> = [];
    const svc = makeUrlFetchService({
      lookupImpl: async () =>
        answers[Math.min(lookups++, answers.length - 1)]!,
      pinnedFetchFactory: (addresses) => {
        factoryCalls.push(addresses);
        return (async (input: unknown) => {
          fetchedUrls.push(String(input));
          return html("public content");
        }) as unknown as typeof fetch;
      },
    });

    const doc = await Effect.runPromise(svc.fetch("https://rebind.example/doc"));

    expect(doc.text).toContain("public content");
    // Resolved exactly once — there is no second resolution to poison.
    expect(lookups).toBe(1);
    // The transport was pinned to exactly what was validated.
    expect(factoryCalls).toEqual([[{ address: "93.184.216.34", family: 4 }]]);
    // The original URL (hostname intact → Host header / SNI preserved).
    expect(fetchedUrls).toEqual(["https://rebind.example/doc"]);
  });

  it("re-resolves, re-validates, and re-pins on every redirect hop", async () => {
    const byHost: Record<string, string> = {
      "a.example": "93.184.216.34",
      "b.example": "1.0.0.1",
    };
    const lookedUp: Array<string> = [];
    const factoryCalls: Array<ReadonlyArray<PinnedAddress>> = [];
    const svc = makeUrlFetchService({
      lookupImpl: async (host) => {
        lookedUp.push(host);
        return [{ address: byHost[host]! }];
      },
      pinnedFetchFactory: (addresses) => {
        factoryCalls.push(addresses);
        return (async (input: unknown) =>
          String(input).includes("a.example")
            ? new Response(null, {
                status: 302,
                headers: { location: "https://b.example/end" },
              })
            : html("arrived")) as unknown as typeof fetch;
      },
    });

    const doc = await Effect.runPromise(svc.fetch("https://a.example/start"));

    expect(doc.text).toContain("arrived");
    expect(lookedUp).toEqual(["a.example", "b.example"]);
    expect(factoryCalls).toEqual([
      [{ address: "93.184.216.34", family: 4 }],
      [{ address: "1.0.0.1", family: 4 }],
    ]);
  });

  it("blocks a redirect hop that resolves to a private address without building a transport for it", async () => {
    const factoryCalls: Array<ReadonlyArray<PinnedAddress>> = [];
    const svc = makeUrlFetchService({
      lookupImpl: async (host) => [
        { address: host === "public.example" ? "93.184.216.34" : "10.0.0.1" },
      ],
      pinnedFetchFactory: (addresses) => {
        factoryCalls.push(addresses);
        return (async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://internal.example/secret" },
          })) as unknown as typeof fetch;
      },
    });

    const err = await Effect.runPromise(
      Effect.flip(svc.fetch("https://public.example/start")),
    );
    expect((err as UrlFetchError).kind).toBe("blocked_host");
    expect(factoryCalls).toHaveLength(1);
  });

  it("rejects when any resolved address is private, even mixed with public ones", async () => {
    const factoryCalls: Array<unknown> = [];
    const svc = makeUrlFetchService({
      lookupImpl: async () => [
        { address: "93.184.216.34" },
        { address: "127.0.0.1" },
      ],
      pinnedFetchFactory: () => {
        factoryCalls.push(true);
        return (async () => html("x")) as unknown as typeof fetch;
      },
    });
    const err = await Effect.runPromise(
      Effect.flip(svc.fetch("https://mixed.example/")),
    );
    expect((err as UrlFetchError).kind).toBe("blocked_host");
    expect(factoryCalls).toHaveLength(0);
  });
});

describe("makePinnedFetch (real transport)", () => {
  it("connects to the pinned IP — never DNS — and preserves the original Host header", async () => {
    const server = createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(`<html><body>host=${req.headers.host ?? ""}</body></html>`);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    try {
      const pinned = makePinnedFetch([{ address: "127.0.0.1", family: 4 }]);
      // `.invalid` is reserved and never resolves: if the transport consulted
      // DNS instead of the pin, this request could not connect at all.
      const res = await pinned(`http://ssrf-pin.invalid:${port}/doc`, {
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
        headers: { "user-agent": "pin-test", accept: "text/html" },
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(`host=ssrf-pin.invalid:${port}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("surfaces redirect statuses without following them", async () => {
    const server = createServer((req, res) => {
      res.statusCode = 302;
      res.setHeader("location", "http://elsewhere.example/");
      res.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    try {
      const pinned = makePinnedFetch([{ address: "127.0.0.1", family: 4 }]);
      const res = await pinned(`http://ssrf-pin.invalid:${port}/`, {
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("http://elsewhere.example/");
      await res.body?.cancel();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
