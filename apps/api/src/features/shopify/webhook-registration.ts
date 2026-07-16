// ============================================================
// Shopify webhook subscription registration
// ============================================================
//
// The uninstall revoke path only runs if Shopify knows where to send
// `APP_UNINSTALLED`. Register that subscription during OAuth while we have
// the freshly-issued offline Admin API token.

export interface RegisterAppUninstalledWebhookOptions {
  readonly shop: string;
  readonly accessToken: string;
  readonly apiVersion: string;
  readonly webhookUrl: string;
  /** Override for tests. Defaults to native fetch. */
  readonly fetchImpl?: typeof fetch;
}

export interface RegisteredWebhook {
  readonly id: string | null;
  readonly topic:
    | "APP_UNINSTALLED"
    | "FULFILLMENTS_CREATE"
    | "FULFILLMENTS_UPDATE";
  readonly uri: string;
  readonly status: "created" | "already_exists";
}

interface RawGraphqlResponse<T> {
  readonly data?: T;
  readonly errors?: ReadonlyArray<{ readonly message?: string }>;
}

interface WebhookCreateResponse {
  readonly webhookSubscriptionCreate?: {
    readonly webhookSubscription?: {
      readonly id?: string | null;
      readonly topic?: string | null;
      readonly uri?: string | null;
    } | null;
    readonly userErrors?: ReadonlyArray<{
      readonly field?: ReadonlyArray<string> | null;
      readonly message?: string | null;
    }>;
  } | null;
}

export class ShopifyWebhookRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShopifyWebhookRegistrationError";
  }
}

export const appUninstalledWebhookUrl = (shopifyCallbackUrl: string): string => {
  const origin = new URL(shopifyCallbackUrl).origin;
  return new URL("/webhooks/shopify/app/uninstalled", origin).toString();
};

export const fulfillmentWebhookUrls = (
  shopifyCallbackUrl: string,
): { readonly created: string; readonly updated: string } => {
  const origin = new URL(shopifyCallbackUrl).origin;
  return {
    created: new URL(
      "/webhooks/shopify/fulfillments/create",
      origin,
    ).toString(),
    updated: new URL(
      "/webhooks/shopify/fulfillments/update",
      origin,
    ).toString(),
  };
};

const CREATE_APP_UNINSTALLED_WEBHOOK = `
mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
    webhookSubscription {
      id
      topic
      uri
    }
    userErrors {
      field
      message
    }
  }
}
`;

const duplicateSubscriptionError = (message: string): boolean => {
  const lower = message.toLowerCase();
  return (
    lower.includes("already") ||
    lower.includes("duplicate") ||
    lower.includes("taken")
  );
};

const registerWebhook = async (
  opts: RegisterAppUninstalledWebhookOptions & {
    readonly topic: RegisteredWebhook["topic"];
  },
): Promise<RegisteredWebhook> => {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(
    `https://${opts.shop}/admin/api/${opts.apiVersion}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": opts.accessToken,
      },
      body: JSON.stringify({
        query: CREATE_APP_UNINSTALLED_WEBHOOK,
        variables: {
          topic: opts.topic,
          webhookSubscription: {
            uri: opts.webhookUrl,
          },
        },
      }),
    },
  );

  const text = await res.text();
  let json: RawGraphqlResponse<WebhookCreateResponse>;
  try {
    json = JSON.parse(text) as RawGraphqlResponse<WebhookCreateResponse>;
  } catch {
    throw new ShopifyWebhookRegistrationError(
      `Shopify webhook registration returned non-JSON response: ${res.status} ${text}`,
    );
  }

  if (!res.ok) {
    throw new ShopifyWebhookRegistrationError(
      `Shopify webhook registration failed: ${res.status} ${text}`,
    );
  }

  if (json.errors && json.errors.length > 0) {
    throw new ShopifyWebhookRegistrationError(
      `Shopify webhook registration GraphQL errors: ${json.errors
        .map((e) => e.message ?? "unknown")
        .join("; ")}`,
    );
  }

  const payload = json.data?.webhookSubscriptionCreate;
  if (!payload) {
    throw new ShopifyWebhookRegistrationError(
      "Shopify webhook registration response missing payload",
    );
  }

  const userErrors = payload.userErrors ?? [];
  if (userErrors.length > 0) {
    const messages = userErrors
      .map((e) => e.message ?? "unknown")
      .filter(Boolean);
    if (messages.some(duplicateSubscriptionError)) {
      return {
        id: null,
        topic: opts.topic,
        uri: opts.webhookUrl,
        status: "already_exists",
      };
    }
    throw new ShopifyWebhookRegistrationError(
      `Shopify webhook registration user errors: ${messages.join("; ")}`,
    );
  }

  const created = payload.webhookSubscription;
  if (!created?.id || created.topic !== opts.topic || !created.uri) {
    throw new ShopifyWebhookRegistrationError(
      "Shopify webhook registration response missing subscription",
    );
  }

  return {
    id: created.id,
    topic: opts.topic,
    uri: created.uri,
    status: "created",
  };
};

export const registerAppUninstalledWebhook = (
  opts: RegisterAppUninstalledWebhookOptions,
): Promise<RegisteredWebhook> =>
  registerWebhook({ ...opts, topic: "APP_UNINSTALLED" });

export interface RegisterFulfillmentWebhooksOptions
  extends Omit<RegisterAppUninstalledWebhookOptions, "webhookUrl"> {
  readonly webhookUrls: {
    readonly created: string;
    readonly updated: string;
  };
}

export const registerFulfillmentWebhooks = (
  opts: RegisterFulfillmentWebhooksOptions,
): Promise<ReadonlyArray<RegisteredWebhook>> =>
  Promise.all([
    registerWebhook({
      ...opts,
      topic: "FULFILLMENTS_CREATE",
      webhookUrl: opts.webhookUrls.created,
    }),
    registerWebhook({
      ...opts,
      topic: "FULFILLMENTS_UPDATE",
      webhookUrl: opts.webhookUrls.updated,
    }),
  ]);
