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
  readonly topic: "APP_UNINSTALLED";
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

export const registerAppUninstalledWebhook = async (
  opts: RegisterAppUninstalledWebhookOptions,
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
          topic: "APP_UNINSTALLED",
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
        topic: "APP_UNINSTALLED",
        uri: opts.webhookUrl,
        status: "already_exists",
      };
    }
    throw new ShopifyWebhookRegistrationError(
      `Shopify webhook registration user errors: ${messages.join("; ")}`,
    );
  }

  const created = payload.webhookSubscription;
  if (!created?.id || created.topic !== "APP_UNINSTALLED" || !created.uri) {
    throw new ShopifyWebhookRegistrationError(
      "Shopify webhook registration response missing subscription",
    );
  }

  return {
    id: created.id,
    topic: "APP_UNINSTALLED",
    uri: created.uri,
    status: "created",
  };
};
