import { describe, expect, it } from "vitest";
import {
  AccessTokenExchangeError,
  exchangeCodeForToken,
} from "../callback.js";

describe("shopify-callback — exchangeCodeForToken", () => {
  it("posts client_id + client_secret + code to /admin/oauth/access_token and parses the response", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fakeFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          access_token: "shpoa_abc",
          scope: "read_orders, read_customers",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await exchangeCodeForToken({
      shop: "acme.myshopify.com",
      clientId: "client-id",
      clientSecret: "client-secret",
      code: "the-code",
      fetchImpl: fakeFetch,
    });

    expect(result.accessToken).toBe("shpoa_abc");
    // Scope is split + trimmed.
    expect(result.scope).toEqual(["read_orders", "read_customers"]);

    const call = calls[0]!;
    expect(call.url).toBe(
      "https://acme.myshopify.com/admin/oauth/access_token",
    );
    expect(call.init?.method).toBe("POST");
    const body = JSON.parse(String(call.init?.body));
    expect(body).toEqual({
      client_id: "client-id",
      client_secret: "client-secret",
      code: "the-code",
    });
  });

  it("throws AccessTokenExchangeError on non-2xx", async () => {
    const fakeFetch = (async () =>
      new Response("nope", { status: 400 })) as unknown as typeof fetch;
    await expect(
      exchangeCodeForToken({
        shop: "acme.myshopify.com",
        clientId: "x",
        clientSecret: "y",
        code: "z",
        fetchImpl: fakeFetch,
      }),
    ).rejects.toBeInstanceOf(AccessTokenExchangeError);
  });

  it("throws when access_token is missing in the response body", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ scope: "read_orders" }), {
        status: 200,
      })) as unknown as typeof fetch;
    await expect(
      exchangeCodeForToken({
        shop: "acme.myshopify.com",
        clientId: "x",
        clientSecret: "y",
        code: "z",
        fetchImpl: fakeFetch,
      }),
    ).rejects.toBeInstanceOf(AccessTokenExchangeError);
  });
});
