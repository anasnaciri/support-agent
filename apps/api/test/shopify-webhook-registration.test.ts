import { describe, expect, it } from "vitest";
import {
  appUninstalledWebhookUrl,
  registerAppUninstalledWebhook,
  ShopifyWebhookRegistrationError,
} from "../src/shopify-webhook-registration.js";

describe("shopify-webhook-registration — appUninstalledWebhookUrl", () => {
  it("derives the uninstall webhook URL from the Shopify callback origin", () => {
    expect(
      appUninstalledWebhookUrl(
        "https://api.example.com/shopify/auth/callback",
      ),
    ).toBe("https://api.example.com/webhooks/shopify/app/uninstalled");
  });
});

describe("shopify-webhook-registration — registerAppUninstalledWebhook", () => {
  it("creates an APP_UNINSTALLED webhook subscription through Admin GraphQL", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fakeFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          data: {
            webhookSubscriptionCreate: {
              webhookSubscription: {
                id: "gid://shopify/WebhookSubscription/1",
                topic: "APP_UNINSTALLED",
                uri: "https://api.example.com/webhooks/shopify/app/uninstalled",
              },
              userErrors: [],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await registerAppUninstalledWebhook({
      shop: "acme.myshopify.com",
      accessToken: "shpoa_abc",
      apiVersion: "2026-04",
      webhookUrl: "https://api.example.com/webhooks/shopify/app/uninstalled",
      fetchImpl: fakeFetch,
    });

    expect(result).toEqual({
      id: "gid://shopify/WebhookSubscription/1",
      topic: "APP_UNINSTALLED",
      uri: "https://api.example.com/webhooks/shopify/app/uninstalled",
      status: "created",
    });
    expect(calls[0]!.url).toBe(
      "https://acme.myshopify.com/admin/api/2026-04/graphql.json",
    );
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body.variables).toEqual({
      topic: "APP_UNINSTALLED",
      webhookSubscription: {
        uri: "https://api.example.com/webhooks/shopify/app/uninstalled",
      },
    });
  });

  it("treats duplicate subscription user errors as idempotent success", async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          data: {
            webhookSubscriptionCreate: {
              webhookSubscription: null,
              userErrors: [
                {
                  field: ["webhookSubscription", "uri"],
                  message: "Address for this topic has already been taken",
                },
              ],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    await expect(
      registerAppUninstalledWebhook({
        shop: "acme.myshopify.com",
        accessToken: "shpoa_abc",
        apiVersion: "2026-04",
        webhookUrl: "https://api.example.com/webhooks/shopify/app/uninstalled",
        fetchImpl: fakeFetch,
      }),
    ).resolves.toEqual({
      id: null,
      topic: "APP_UNINSTALLED",
      uri: "https://api.example.com/webhooks/shopify/app/uninstalled",
      status: "already_exists",
    });
  });

  it("throws on non-duplicate user errors", async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          data: {
            webhookSubscriptionCreate: {
              webhookSubscription: null,
              userErrors: [{ message: "You cannot create this topic" }],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    await expect(
      registerAppUninstalledWebhook({
        shop: "acme.myshopify.com",
        accessToken: "shpoa_abc",
        apiVersion: "2026-04",
        webhookUrl: "https://api.example.com/webhooks/shopify/app/uninstalled",
        fetchImpl: fakeFetch,
      }),
    ).rejects.toBeInstanceOf(ShopifyWebhookRegistrationError);
  });
});
