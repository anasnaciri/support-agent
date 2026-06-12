import { Effect, Layer } from "effect";
import {
  ApprovalService,
  BlobStorage,
  BlobStorageTest,
  CaseRepository,
  ConnectorCredentialStore,
  ConversationService,
  KnowledgeBaseService,
  parseKey,
  ShopifyAppProvisioningStore,
  ShopifyService,
  TenantAgentOverridesService,
  TenantRepository,
  TransactionRunner,
  UrlFetchService,
} from "@support-agent/services";
import {
  ApprovalServiceLive,
  CaseRepositoryLive,
  ConnectorCredentialStoreLive,
  DbClient,
  DbClientLive,
  KnowledgeBaseServiceLive,
  ShopifyAppProvisioningStoreLive,
  TenantAgentOverridesServiceLive,
  TenantRepositoryLive,
  TransactionRunnerLive,
} from "@support-agent/db";
import {
  BlobStorageConfigFromEnv,
  BlobStorageLive,
  ConversationRouterLive,
  makeCaseProviderResolver,
  makeGmailConversation,
  makeGraphConversation,
  makeImapSmtpConversation,
  ShopifyCredentialStoreFromConnector,
  ShopifyHttpLive,
  ShopifyServiceLive,
  UrlFetchServiceLive,
} from "@support-agent/providers";

// ============================================================
// Env validation
// ============================================================

export interface ShopifyAppConfig {
  /**
   * The deployment-wide ("global") Shopify app credentials (SaaS path).
   * `null` in a pure-pilot deployment (`SHOPIFY_CONNECT_REQUIRES_PROVISIONING`
   * = true) that ships no global app — every tenant uses its own provisioned
   * custom app instead (audit A6). `callbackUrl` / `apiVersion` are
   * deployment-level (the api's own callback endpoint + Admin API version) and
   * are always required.
   */
  readonly clientId: string | null;
  readonly clientSecret: string | null;
  readonly callbackUrl: string;
  readonly apiVersion: string;
}

/**
 * The scope set our runtime expects the merchant to grant. This is
 * NOT what we request at install time — that lives in the Shopify
 * Partner Dashboard ("Required access scopes"), which is the binding
 * source of truth. When you edit the dashboard config, Shopify
 * auto-prompts existing merchants to update permissions on their next
 * visit; we don't need to coordinate a "go reinstall" message.
 *
 * This list serves two read-only purposes in code:
 *   1. The integrations page renders it as a capability grid against
 *      `connector_connections.scopes` (the actually-granted set,
 *      returned in the OAuth callback). Lets the operator see at a
 *      glance whether the merchant has granted enough access.
 *   2. Documentation for which tool needs which scope:
 *      - `read_orders`      → shopify.get_order, shopify.findOrderByName
 *      - `read_customers`   → shopify.get_customer, shopify.searchByEmail
 *      - `read_products`    → shopify.get_product (damaged-product photo
 *                             cross-check)
 *      - `write_orders`     → refund.create (and future order-edit tools)
 *      - `read_locations`   → shopify.list_pickup_locations (general-inquiry
 *                             pickup answers; the service filters to
 *                             pickup-enabled locations only)
 *      - `read_legal_policies` → post-connect shop-policy import (seeds the
 *                             knowledge base with the store's shipping +
 *                             refund policy text). Not tied to a tool — the
 *                             import is a best-effort worker job.
 *      - `read_online_store_pages` → the same import job's page leg
 *                             (About / Contact / FAQ → knowledge base).
 *                             Best-effort: installs predating this scope
 *                             skip the page leg until the merchant
 *                             re-OAuths.
 *
 * Keep aligned with the Partner Dashboard config AND `shopify.app.toml`.
 * The `shopify-tool-scopes` test asserts every Shopify tool's
 * `requiredConnectorScopes` is covered here, so a new scoped tool can't
 * silently outrun the requested scopes.
 */
export const DEFAULT_SHOPIFY_SCOPES: ReadonlyArray<string> = [
  "read_orders",
  "read_customers",
  "read_products",
  "write_orders",
  "read_legal_policies",
  "read_online_store_pages",
  "read_locations",
];

export interface GoogleAppConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly callbackUrl: string;
  /**
   * Fully-qualified Pub/Sub topic the Gmail watch publishes to, e.g.
   * `projects/<gcp-project>/topics/gmail-inbox`. Null when Google OAuth is
   * configured for non-Gmail connectors only.
   */
  readonly pubsubTopic: string | null;
  /**
   * Shared secret the Pub/Sub push subscription must include in the
   * webhook URL query (`?token=…`). Without this, anyone hitting our
   * `/webhooks/conversations/gmail` endpoint can replay
   * mailbox-update notifications. Generate with `randomBytes(32).hex`.
   */
  readonly pushToken: string | null;
}

export interface MicrosoftAppConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly callbackUrl: string;
  /** Azure AD tenant segment for authorize/token endpoints. Defaults to "common". */
  readonly tenant: string;
  /**
   * Public URL Microsoft Graph posts mailbox change notifications to (the
   * api's `/webhooks/conversations/outlook/:tenantId`). `null` disables
   * subscription creation on install — used by the inbound webhook slice.
   */
  readonly notificationUrl: string | null;
  /**
   * Secret echoed back in every Graph change notification's `clientState`,
   * verified on receipt so only our own subscriptions can drive the webhook.
   */
  readonly webhookClientState: string | null;
}

export interface ApiConfig {
  readonly port: number;
  readonly databaseUrl: string;
  readonly encryptionKey: Buffer;
  readonly stateSigningKey: string;
  readonly shopify: ShopifyAppConfig;
  /**
   * `null` when Google OAuth env vars are unset — the API still boots and
   * Shopify routes work; `/google/*` responds 503 in that case. Gmail
   * webhooks additionally require `GMAIL_PUSH_TOKEN`.
   */
  readonly google: GoogleAppConfig | null;
  /**
   * `null` when Microsoft OAuth env vars are unset. When set, the API exposes
   * `/microsoft/install` + `/microsoft/auth/callback` for the Outlook / O365
   * conversation connector; `null` makes those routes respond 503.
   */
  readonly microsoft: MicrosoftAppConfig | null;
  /**
   * Shared HMAC secret for approval-link tokens. Verifies the signed
   * `?token=...` on `/approvals/:id/approve|reject` URLs. MUST be the
   * same value the worker uses to sign tokens (APPROVAL_SIGNING_KEY env
   * in apps/worker). Required even when no approvals are yet in flight —
   * the worker may have already mailed live links before this restart.
   */
  readonly approvalSigningKey: string;
  /**
   * Public origin of the dashboard (`apps/dashboard`), e.g.
   * `https://app.example.com`. When set, a successful connector OAuth
   * callback redirects the merchant back to the dashboard's
   * `/settings/integrations` page (landing them inside our own app, the
   * way Claude returns you to its connectors page) instead of the
   * standalone `/installed` landing page. `null` → keep the `/installed`
   * fallback. May carry a path prefix.
   */
  readonly dashboardBaseUrl: string | null;
  /**
   * Shared service token the dashboard (Cloudflare Worker) presents as
   * `Authorization: Bearer <token>` when calling the `/dashboard/*` read
   * API (Path B). `null` → those routes respond 503 (not configured).
   * The dashboard does the WorkOS user auth and asserts its `x-org-id`;
   * the api trusts this token and maps org → tenant.
   */
  readonly dashboardApiToken: string | null;
  /**
   * Bearer token guarding the platform-operator admin endpoints
   * (`POST /admin/tenants/:id/delete` — delete *any* tenant's account).
   * Distinct from `dashboardApiToken`, which is org-scoped. `null` → the
   * admin routes respond 503 (not configured).
   */
  readonly adminApiToken: string | null;
  /**
   * Pilot custom distribution: when `true`, the dashboard's "Connect Shopify"
   * button stays disabled until an operator has provisioned the tenant's
   * Shopify custom app (a `shopify_app_provisioning` row). Default `false`
   * keeps the SaaS self-serve behaviour (Connect always available). Set
   * `SHOPIFY_CONNECT_REQUIRES_PROVISIONING=true` for a pilot deployment.
   */
  readonly shopifyConnectRequiresProvisioning: boolean;
}

const requireEnv = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
};

export const loadApiConfig = (): ApiConfig => {
  const callbackUrl = requireEnv("SHOPIFY_APP_CALLBACK_URL");
  // Shopify rejects non-https callback URLs (including http://localhost)
  // at registration time. Failing here gives a clearer error than letting
  // the bad URL surface as a Partner Dashboard validation error or, worse,
  // a confusing OAuth failure mid-flow. Tests use http:// against an
  // ephemeral local server and set NODE_ENV=test (or skip this check via
  // ALLOW_HTTP_CALLBACK=1 for any other local need).
  const allowHttp =
    process.env["NODE_ENV"] === "test" ||
    process.env["ALLOW_HTTP_CALLBACK"] === "1";
  if (!callbackUrl.startsWith("https://") && !allowHttp) {
    throw new Error(
      `SHOPIFY_APP_CALLBACK_URL must use https:// (got ${callbackUrl}). Expose apps/api through the Cloudflare Tunnel in cloudflared/ or set ALLOW_HTTP_CALLBACK=1 for a non-Shopify local test.`,
    );
  }
  const googleClientId = process.env["GOOGLE_OAUTH_CLIENT_ID"];
  const googleClientSecret = process.env["GOOGLE_OAUTH_CLIENT_SECRET"];
  const googleCallbackUrl = process.env["GOOGLE_OAUTH_CALLBACK_URL"];
  const googlePubsubTopic = process.env["GMAIL_PUBSUB_TOPIC"];
  const googlePushToken = process.env["GMAIL_PUSH_TOKEN"];
  const googleConfigured =
    !!googleClientId && !!googleClientSecret && !!googleCallbackUrl;
  if (googleConfigured && !googleCallbackUrl.startsWith("https://") && !allowHttp) {
    throw new Error(
      `GOOGLE_OAUTH_CALLBACK_URL must use https:// (got ${googleCallbackUrl}). Google rejects http callbacks except for http://localhost loopback installs.`,
    );
  }
  const msClientId = process.env["MICROSOFT_OAUTH_CLIENT_ID"];
  const msClientSecret = process.env["MICROSOFT_OAUTH_CLIENT_SECRET"];
  const msCallbackUrl = process.env["MICROSOFT_OAUTH_CALLBACK_URL"];
  const msTenant = process.env["MICROSOFT_OAUTH_TENANT"]?.trim() || "common";
  const msNotificationUrl =
    process.env["MICROSOFT_GRAPH_NOTIFICATION_URL"]?.trim() || null;
  const msWebhookClientState =
    process.env["MICROSOFT_GRAPH_WEBHOOK_SECRET"]?.trim() || null;
  const microsoftConfigured =
    !!msClientId && !!msClientSecret && !!msCallbackUrl;
  if (microsoftConfigured && !msCallbackUrl.startsWith("https://") && !allowHttp) {
    throw new Error(
      `MICROSOFT_OAUTH_CALLBACK_URL must use https:// (got ${msCallbackUrl}). Microsoft rejects non-https redirect URIs except http://localhost.`,
    );
  }
  // The Graph webhook's ONLY authentication is the clientState shared
  // secret; the handler fails closed without it (audit S4). Surface the
  // misconfiguration at boot rather than as silently-rejected inbound
  // notifications once subscriptions start delivering.
  if (microsoftConfigured && msNotificationUrl && !msWebhookClientState) {
    throw new Error(
      "MICROSOFT_GRAPH_WEBHOOK_SECRET must be set when MICROSOFT_GRAPH_NOTIFICATION_URL is configured — Graph notifications are authenticated solely by clientState and are rejected without it.",
    );
  }
  // Pilot mode (SHOPIFY_CONNECT_REQUIRES_PROVISIONING=true) is PURE per-tenant
  // provisioning — every tenant uses its own operator-provisioned custom app.
  // A deployment-wide ("global") Shopify app is NOT allowed: keeping one around
  // would be an ambiguous hybrid where an unprovisioned tenant might fall back
  // to it. So the global creds must be absent in pilot mode (fail fast if set),
  // and required in SaaS mode (audit A6). callbackUrl/apiVersion are always
  // required — they're the api's own callback endpoint + Admin API version.
  const requiresProvisioning =
    process.env["SHOPIFY_CONNECT_REQUIRES_PROVISIONING"]?.trim() === "true";
  const rawShopifyClientId = process.env["SHOPIFY_APP_CLIENT_ID"]?.trim() || null;
  const rawShopifyClientSecret =
    process.env["SHOPIFY_APP_CLIENT_SECRET"]?.trim() || null;
  let shopifyClientId: string | null;
  let shopifyClientSecret: string | null;
  if (requiresProvisioning) {
    if (rawShopifyClientId || rawShopifyClientSecret) {
      throw new Error(
        "SHOPIFY_APP_CLIENT_ID/SECRET must NOT be set when SHOPIFY_CONNECT_REQUIRES_PROVISIONING=true — pilot mode uses per-tenant provisioned apps only, with no global app. Unset the global Shopify credentials.",
      );
    }
    shopifyClientId = null;
    shopifyClientSecret = null;
  } else {
    shopifyClientId = requireEnv("SHOPIFY_APP_CLIENT_ID");
    shopifyClientSecret = requireEnv("SHOPIFY_APP_CLIENT_SECRET");
  }
  return {
    port: Number(process.env["API_PORT"] ?? 4000),
    databaseUrl: requireEnv("DATABASE_URL"),
    encryptionKey: parseKey(requireEnv("CREDENTIAL_ENCRYPTION_KEY")),
    stateSigningKey: requireEnv("STATE_SIGNING_KEY"),
    shopify: {
      clientId: shopifyClientId,
      clientSecret: shopifyClientSecret,
      callbackUrl,
      apiVersion: process.env["SHOPIFY_API_VERSION"] ?? "2026-04",
    },
    approvalSigningKey: requireEnv("APPROVAL_SIGNING_KEY"),
    dashboardBaseUrl: process.env["DASHBOARD_BASE_URL"]?.trim() || null,
    dashboardApiToken: process.env["DASHBOARD_API_TOKEN"]?.trim() || null,
    adminApiToken: process.env["ADMIN_API_TOKEN"]?.trim() || null,
    shopifyConnectRequiresProvisioning: requiresProvisioning,
    google: googleConfigured
      ? {
          clientId: googleClientId,
          clientSecret: googleClientSecret,
          callbackUrl: googleCallbackUrl,
          pubsubTopic: googlePubsubTopic ?? null,
          pushToken: googlePushToken ?? null,
        }
      : null,
    microsoft: microsoftConfigured
      ? {
          clientId: msClientId,
          clientSecret: msClientSecret,
          callbackUrl: msCallbackUrl,
          tenant: msTenant,
          notificationUrl: msNotificationUrl,
          webhookClientState: msWebhookClientState,
        }
      : null,
  };
};

// ============================================================
// Layers
// ============================================================

export const buildApiLayers = (cfg: ApiConfig) => {
  const dbLayer = DbClientLive({ databaseUrl: cfg.databaseUrl });
  const store = ConnectorCredentialStoreLive(cfg.encryptionKey).pipe(
    Layer.provide(dbLayer),
  );
  // Pilot custom distribution: per-tenant Shopify app credentials. Shares
  // the credential encryption key with the connector store.
  const appProvisioning = ShopifyAppProvisioningStoreLive(
    cfg.encryptionKey,
  ).pipe(Layer.provide(dbLayer));
  const caseRepo = CaseRepositoryLive.pipe(Layer.provide(dbLayer));
  const connectorBuilders = [
    ...(cfg.google
      ? ([
          [
            "gmail",
            makeGmailConversation({
              clientId: cfg.google.clientId,
              clientSecret: cfg.google.clientSecret,
            }),
          ],
        ] as const)
      : []),
    ...(cfg.microsoft
      ? ([
          [
            "outlook",
            makeGraphConversation({
              clientId: cfg.microsoft.clientId,
              clientSecret: cfg.microsoft.clientSecret,
              tenant: cfg.microsoft.tenant,
            }),
          ],
        ] as const)
      : []),
    ...([["imap", makeImapSmtpConversation()]] as const),
  ];
  const conversation = ConversationRouterLive(
    connectorBuilders,
    makeCaseProviderResolver,
  ).pipe(Layer.provide(Layer.mergeAll(store, caseRepo)));
  // ApprovalServiceLive lets `/approvals/:id/approve|reject` mark the
  // row decided in the same Live impl the runtime uses to create them.
  const approvals = ApprovalServiceLive.pipe(Layer.provide(dbLayer));
  const tx = TransactionRunnerLive.pipe(Layer.provide(dbLayer));
  // BlobStorage: Live over R2 when R2_* env is set (Gmail webhook
  // uploads image attachments here so the runtime / LLM can read them
  // back); in-memory Test layer otherwise — dev + integration tests
  // that exercise the webhook without R2 still work, they just store
  // bytes in process memory.
  const blob = process.env["R2_BUCKET"]
    ? BlobStorageLive.pipe(Layer.provide(BlobStorageConfigFromEnv))
    : BlobStorageTest({});
  // ShopifyService for the dashboard's case-detail customer/order panels.
  // Credentials resolve per-tenant from the DB-backed connector store (the
  // managed-install path); the layer itself builds without any Shopify env.
  const shopify = ShopifyServiceLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        ShopifyHttpLive,
        ShopifyCredentialStoreFromConnector().pipe(Layer.provide(store)),
      ),
    ),
  );
  // TenantRepository (refund policy + supplier-escalation sheet) and
  // TenantAgentOverridesService (per-agent model overrides) back the dashboard
  // settings-write endpoints (Path B). Both are DB-backed.
  const tenantRepo = TenantRepositoryLive.pipe(Layer.provide(dbLayer));
  const agentOverridesSvc = TenantAgentOverridesServiceLive.pipe(
    Layer.provide(dbLayer),
  );
  // Knowledge base: CRUD for the settings/knowledge endpoints. UrlFetchService
  // (SSRF-guarded) backs the "add from URL" / resync paths; it has no deps.
  const knowledge = KnowledgeBaseServiceLive.pipe(Layer.provide(dbLayer));
  const urlFetch = UrlFetchServiceLive;
  return Layer.mergeAll(
    store,
    appProvisioning,
    caseRepo,
    conversation,
    approvals,
    tx,
    dbLayer,
    blob,
    shopify,
    tenantRepo,
    agentOverridesSvc,
    knowledge,
    urlFetch,
  );
};

export type ApiLayer = Layer.Layer<
  | ConnectorCredentialStore
  | ConversationService
  | CaseRepository
  | ShopifyAppProvisioningStore
  | ApprovalService
  | TransactionRunner
  | DbClient
  | BlobStorage
  | ShopifyService
  | TenantRepository
  | TenantAgentOverridesService
  | KnowledgeBaseService
  | UrlFetchService,
  never,
  never
>;
