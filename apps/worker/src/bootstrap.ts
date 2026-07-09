import { Layer } from "effect";
import {
  AgentRegistryWith,
  ToolRegistryWith,
} from "@support-agent/agent-core";
import { ALL_AGENTS, AgentResolverLive } from "@support-agent/agents";
import { ALL_TOOLS } from "@support-agent/tools";
import {
  AgentRuntimeDefault,
  AccountOpenRouterCredentialStoreTest,
  ApprovalLinkConfig,
  BlobStorageTest,
  TicketLifecycleWriterLive,
  ConnectorCredentialStore,
  ConversationServiceTest,
  OrgDirectoryServiceTest,
  PermissionServiceLive,
  PlatformMailServiceTest,
  type AgentRuntime,
  type OrgDirectoryService,
  type PlatformMailService,
  type ApprovalService,
  type AuditLogService,
  type BlobStorage,
  type TicketAttachmentStore,
  type TicketLifecycleWriter,
  type TicketRepository,
  type ConnectorConnection,
  type ConversationService,
  type ShopifyService,
  type SheetsService,
  type TenantRepository,
  type KnowledgeBaseService,
  type ProcessedEventStore,
  type TimerService,
  type TrackingService,
  type TransactionRunner,
  SheetsServiceTest,
  TrackingConfig,
  TrackingServiceNoProvider,
} from "@support-agent/services";
import { Effect } from "effect";
import {
  ApprovalServiceLive,
  AccountOpenRouterCredentialStoreLive,
  AuditLogServiceLive,
  AuditLogServiceLiveRedacted,
  TicketRepositoryLive,
  ConnectorCredentialStoreLive,
  CustomAgentServiceLive,
  DbClient,
  DbClientLive,
  SupplierEscalationServiceLive,
  ReplyDeliveryServiceLive,
  ImageHashStoreLive,
  TicketAttachmentStoreLive,
  ProcessedEventStoreLive,
  ProcessedMessageStoreLive,
  ToolExecutionStoreLive,
  KnowledgeBaseServiceLive,
  LLMCredentialResolverLive,
  TenantAgentOverridesServiceLive,
  TenantRepositoryLive,
  TimerServiceLive,
  TransactionRunnerLive,
} from "@support-agent/db";
import { parseKeySet } from "@support-agent/services";
import {
  BlobStorageConfigFromEnv,
  BlobStorageLive,
  ConversationRouterLive,
  makeTicketProviderResolver,
  makeGmailConversation,
  makeGraphConversation,
  makeImapSmtpConversation,
  LLMConfigFromEnv,
  LLMCredentialResolverFromLLMConfig,
  LLMServiceLive,
  OrgDirectoryServiceLive,
  MerchantNotificationLive,
  PlatformMailServiceLive,
  ResendConfigFromEnv,
  TelegramConfigFromEnv,
  WorkosConfigFromEnv,
  ShopifyCredentialStoreFromConnector,
  ShopifyCredentialStoreFromEnv,
  ShopifyHttpLive,
  ShopifyServiceLive,
  SheetsServiceLive,
  TrackingServiceLive,
} from "@support-agent/providers";
import { makeQueue, type PgBoss } from "./queue.js";

// ============================================================
// Public surface
// ============================================================

/**
 * Everything the worker entrypoint needs to start consuming events.
 * The `runtimeLayer` exposes `AgentRuntime` AND its tool-side dependencies
 * (`TicketRepository`, `ShopifyService`, etc.) to the outer fiber — tools
 * yield those services from inside `execute`, so the runtime alone is
 * not enough on the consumer side.
 */
export interface WorkerBootstrap {
  readonly boss: PgBoss;
  readonly runtimeLayer: Layer.Layer<
    | AgentRuntime
    | TicketLifecycleWriter
    | TicketRepository
    | AuditLogService
    | ApprovalService
    | ShopifyService
    | SheetsService
    | TimerService
    | TrackingService
    | ConversationService
    | TenantRepository
    | KnowledgeBaseService
    | TransactionRunner
    | BlobStorage
    // Exposed at the top level (not just provided INTO the runtime) so the
    // reply-delivery retry cron can resolve a stored draft's attachments and
    // bind them to the message it re-sends.
    | TicketAttachmentStore
    | OrgDirectoryService
    | PlatformMailService
    | ApprovalLinkConfig
    | ConnectorCredentialStore
    | ProcessedEventStore
    | DbClient,
    never,
    never
  >;
  /**
   * Credential-decryption key SET (audit S15), primary first, for decrypting
   * connector-grant tokens in the account-cleanup job. `null` in single-tenant
   * dev with no key configured — grant revocation is then skipped.
   */
  readonly credentialEncryptionKeys: ReadonlyArray<Buffer> | null;
  readonly shutdown: () => Promise<void>;
}

// ============================================================
// Env validation
// ============================================================

export interface BootstrapOptions {
  /**
   * If true, the bootstrap fails fast when SHOPIFY_TEST_* credentials are
   * absent. If false (the default), Shopify-backed tools won't work at
   * runtime but the worker still boots — useful for environments that
   * only handle non-Shopify events.
   */
  readonly requireShopify?: boolean;
}

const requireEnv = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
};

/**
 * Build the credential-decryption key SET from env (audit S15 rotation), or
 * `null` when no CREDENTIAL_ENCRYPTION_KEY is set (single-tenant dev). Primary
 * first: `[CREDENTIAL_ENCRYPTION_KEY, ...CREDENTIAL_ENCRYPTION_KEY_PREVIOUS]`.
 * Writes encrypt with the primary; reads fall back to the previous keys so a
 * key roll keeps existing ciphertext readable. Pure (takes env) so it's
 * unit-testable.
 */
export const parseEncryptionKeySet = (
  env: Record<string, string | undefined>,
): ReadonlyArray<Buffer> | null => {
  const primary = env["CREDENTIAL_ENCRYPTION_KEY"];
  if (!primary) return null;
  return parseKeySet(primary, env["CREDENTIAL_ENCRYPTION_KEY_PREVIOUS"]);
};

/** Env vars the worker must have in production — without them account
 * deletion silently skips the WorkOS org delete + the deletion email, and
 * approval links get signed with a predictable dev key (5th-audit #6). */
export const WORKER_REQUIRED_PROD_ENV = [
  "CREDENTIAL_ENCRYPTION_KEY",
  "APPROVAL_SIGNING_KEY",
  "WORKOS_API_KEY",
  "RESEND_API_KEY",
  "RESEND_FROM_ADDRESS",
] as const;

/**
 * Fail fast when a production worker is missing a required service env var,
 * instead of silently booting with Test/no-op layers. Pure (takes env) so it's
 * unit-testable. No-op outside production.
 */
export const assertProductionServicesConfigured = (
  env: Record<string, string | undefined>,
): void => {
  if (env["NODE_ENV"] !== "production") return;
  const platformMailEnabled = env["PLATFORM_MAIL_ENABLED"] !== "false";
  const missing = WORKER_REQUIRED_PROD_ENV.filter(
    (name) =>
      !env[name] &&
      (platformMailEnabled ||
        (name !== "RESEND_API_KEY" && name !== "RESEND_FROM_ADDRESS")),
  );
  if (missing.length > 0) {
    throw new Error(
      `Worker production startup requires ${missing.join(", ")} — refusing to boot with no-op fallbacks (account deletion / email / approval signing would silently break). 5th-audit #6.`,
    );
  }
};

// ============================================================
// Build
// ============================================================

export const buildWorker = async (
  opts: BootstrapOptions = {},
): Promise<WorkerBootstrap> => {
  const databaseUrl = requireEnv("DATABASE_URL");

  // Production must NOT silently fall back to Test/no-op services (5th-audit
  // #6): without these, account deletion would skip the WorkOS org delete +
  // the deletion email, and approval links would be signed with a predictable
  // dev key. Fail fast at startup instead of discovering it on the first job.
  // Optional CONNECTORS (Gmail/Sheets/17track) are NOT required here — a
  // Shopify-only pilot legitimately omits them — but their fallbacks below
  // warn loudly in production rather than going silent.
  const isProd = process.env["NODE_ENV"] === "production";
  assertProductionServicesConfigured(process.env);
  // Optional connectors that fell back to a no-op layer in production are a
  // likely misconfiguration — surface it loudly instead of silently skipping
  // the feature (5th-audit #6).
  const warnProdFallback = (service: string, envHint: string): void => {
    if (isProd) {
      // eslint-disable-next-line no-console
      console.warn(
        `[worker] ${service} is using a NO-OP fallback in production — set ${envHint} if this connector should work.`,
      );
    }
  };

  // BYOK: in production the LLM credential is per-tenant, read from
  // `connector_connections` via LLMCredentialResolverLive — that requires
  // CREDENTIAL_ENCRYPTION_KEY. In single-tenant dev we fall back to the
  // OPENROUTER_API_KEY env layer (LLMCredentialResolverFromLLMConfig) so
  // the worker still boots without a DB-backed key. One of the two MUST be
  // set; otherwise crash here rather than discovering it on the first
  // message.
  const credKeyB64 = process.env["CREDENTIAL_ENCRYPTION_KEY"];
  // Rotation key SET (audit S15): primary first, optional previous keys
  // appended. The credential stores encrypt with the primary and decrypt
  // against the whole set; `null` in single-tenant dev with no key.
  const encryptionKeys = parseEncryptionKeySet(process.env);
  const hasDevOpenrouter = Boolean(process.env["OPENROUTER_API_KEY"]);
  if (!credKeyB64 && !hasDevOpenrouter) {
    throw new Error(
      "BYOK: set CREDENTIAL_ENCRYPTION_KEY (production, per-tenant keys from connector_connections) or OPENROUTER_API_KEY (single-tenant dev)",
    );
  }

  // Pick the Shopify credential source:
  //   - If CREDENTIAL_ENCRYPTION_KEY is set, read tokens from
  //     `connector_connections` (production / managed-install path).
  //   - Otherwise fall back to SHOPIFY_TEST_* env vars (dev / single-tenant).
  // `requireShopify` only gates the env-fallback variant — when we're on
  // the connector-backed path we don't expect SHOPIFY_TEST_* to be set.
  if (!credKeyB64 && opts.requireShopify) {
    requireEnv("SHOPIFY_TEST_SHOP_DOMAIN");
    requireEnv("SHOPIFY_TEST_ACCESS_TOKEN");
  }

  const boss = await makeQueue({ databaseUrl });

  // ---- Live layers ----
  // DbClient is the root dep; everything db-related provides over it.
  const dbLayer = DbClientLive({ databaseUrl });

  // PII redaction toggle for audit_log inserts. Default OFF for full
  // debug fidelity in dev; production deployments set
  // AUDIT_LOG_REDACT_PII=1 to scrub known-PII fields (emails, phones,
  // address blocks, customer-facing message bodies) at write time.
  // Old rows persisted before the flag flipped stay as-is — we don't
  // backfill historical redaction.
  const redactAuditPii = process.env["AUDIT_LOG_REDACT_PII"] === "1";
  const auditLogLayer = redactAuditPii
    ? AuditLogServiceLiveRedacted
    : AuditLogServiceLive;

  // Repos + tx runner — all depend on DbClient.
  const baseRepos = Layer.mergeAll(
    TicketRepositoryLive,
    auditLogLayer,
    ApprovalServiceLive,
    TransactionRunnerLive,
    TenantAgentOverridesServiceLive,
    // Backs both the agent prompt's knowledge-doc title header and the
    // `knowledge.search` tool the specialists call.
    KnowledgeBaseServiceLive,
    TimerServiceLive,
    // At-least-once idempotency (audit C2/C3, H7): processed-message dedup,
    // tool-execution markers, and event-level (eventId) dedup. The runtime
    // treats them as optional — wiring them here turns the dedup on in prod.
    ProcessedMessageStoreLive,
    ProcessedEventStoreLive,
    ToolExecutionStoreLive,
    // Exposed for worker services that need tenant settings. TenantRepository
    // consumers (PlatformMailService, PermissionServiceLive)
    // are provided their own copy via inner Layer.provide; both copies
    // collapse to the same Live impl, so duplicating is harmless.
    TenantRepositoryLive,
    // Backs the supplier.escalate tool — records the escalation row + resolves
    // the workspace's supplier so the runtime can park in waiting_for_supplier.
    SupplierEscalationServiceLive,
    // Durable outbox for FAILED customer-reply sends: the runtime enqueues here
    // on a send failure so the retry cron + the dashboard retry button can
    // re-send the verbatim draft. DbClient-backed (satisfied by the dbLayer
    // provide below).
    ReplyDeliveryServiceLive,
  );
  const repos = Layer.provideMerge(TicketLifecycleWriterLive, baseRepos);

  // LLM — depends on LLMCredentialResolver. In production each tenant
  // brings their own provider + key (resolver consults the same
  // ConnectorCredentialStoreLive that Shopify/Gmail OAuth writes to).
  // In single-tenant dev we adapt OPENROUTER_API_KEY to a resolver that
  // returns the same credential for every tenant.
  const accountOpenrouterStore = credKeyB64
    ? AccountOpenRouterCredentialStoreLive(encryptionKeys!)
    : AccountOpenRouterCredentialStoreTest();
  const llmResolver = credKeyB64
    ? LLMCredentialResolverLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            ConnectorCredentialStoreLive(encryptionKeys!),
            accountOpenrouterStore,
            dbLayer,
          ),
        ),
      )
    : LLMCredentialResolverFromLLMConfig.pipe(
        Layer.provide(LLMConfigFromEnv),
      );

  // Object storage. The Gmail webhook uploads image attachments here so
  // the runtime can hand them to the LLM as multimodal parts. Live R2
  // when R2_* env is set; otherwise an in-memory Test layer so dev +
  // CI work without an R2 account. Picked at boot time and shared
  // between LLMServiceLive (reads back bytes on the LLM boundary) and
  // any future worker code that uploads from Effect (today only the
  // Gmail webhook uploads, and that runs in apps/api).
  const blob = process.env["R2_BUCKET"]
    ? BlobStorageLive.pipe(Layer.provide(BlobStorageConfigFromEnv))
    : BlobStorageTest({});

  const llm = LLMServiceLive.pipe(
    Layer.provide(Layer.mergeAll(llmResolver, blob)),
  );

  // Shopify — depends on ShopifyHttp + ShopifyCredentialStore. When the
  // encryption key is present, resolve credentials from the DB-backed
  // ConnectorCredentialStore (managed-install path); otherwise fall back
  // to env-supplied creds for single-tenant dev.
  const credentialStoreLayer = credKeyB64
    ? ShopifyCredentialStoreFromConnector().pipe(
        Layer.provide(ConnectorCredentialStoreLive(encryptionKeys!)),
      )
    : ShopifyCredentialStoreFromEnv;
  const shopify = ShopifyServiceLive.pipe(
    Layer.provide(Layer.mergeAll(ShopifyHttpLive, credentialStoreLayer)),
  );

  // Platform mail (approval-link emails to the operator). Production requires
  // Resend by default; PLATFORM_MAIL_ENABLED=false is the explicit pilot
  // opt-out when dashboard approvals are sufficient and no platform-originated
  // email should be sent.
  const platformMailEnabled = process.env["PLATFORM_MAIL_ENABLED"] !== "false";
  const resendApiKey = process.env["RESEND_API_KEY"];
  const resendFrom = process.env["RESEND_FROM_ADDRESS"];
  const mail =
    platformMailEnabled && resendApiKey && resendFrom
      ? PlatformMailServiceLive.pipe(
          Layer.provide(
            Layer.mergeAll(TenantRepositoryLive, ResendConfigFromEnv),
          ),
        )
      : PlatformMailServiceTest({});
  if (isProd && !platformMailEnabled) {
    // eslint-disable-next-line no-console
    console.warn(
      "[worker] platform mail is explicitly disabled — approval-link, account-deletion, and system emails will not be sent.",
    );
  }

  // Merchant push notifications — MULTI-CHANNEL: ALWAYS email the operator
  // (via the platform mail layer → tenant notificationEmail) AND ping Telegram
  // when the bot env trio + the encryption key (per-tenant chat bindings live
  // in connector_connections) are present. Each channel is best-effort; one
  // failing or being absent never blocks the other. With neither configured the
  // notifier still builds (email channel resolves no recipient → delivered
  // false), so the merchant.notify tool + runtime/cron emitters degrade exactly
  // like "tenant not linked".
  const tgBotToken = process.env["TELEGRAM_BOT_TOKEN"];
  const tgBotUsername = process.env["TELEGRAM_BOT_USERNAME"];
  const tgWebhookSecret = process.env["TELEGRAM_WEBHOOK_SECRET"];
  const telegramConfigured = Boolean(
    credKeyB64 && tgBotToken && tgBotUsername && tgWebhookSecret,
  );
  if (!telegramConfigured) {
    warnProdFallback(
      "Merchant Telegram pings (email channel still active)",
      "TELEGRAM_BOT_TOKEN + TELEGRAM_BOT_USERNAME + TELEGRAM_WEBHOOK_SECRET (with CREDENTIAL_ENCRYPTION_KEY)",
    );
  }
  const merchantNotifications = MerchantNotificationLive.pipe(
    Layer.provide(
      telegramConfigured
        ? Layer.mergeAll(
            mail,
            TelegramConfigFromEnv,
            ConnectorCredentialStoreLive(encryptionKeys!),
          )
        : mail,
    ),
  );

  // Org directory (WorkOS) — used by the account-cleanup consumer to delete
  // a tenant's organization after self-service / admin account deletion.
  // Live when WORKOS_API_KEY is set; otherwise an in-memory Test layer so
  // the worker still boots for dev/CI without WorkOS creds (org deletes
  // become no-ops there).
  const orgDirectory = process.env["WORKOS_API_KEY"]
    ? OrgDirectoryServiceLive.pipe(Layer.provide(WorkosConfigFromEnv))
    : OrgDirectoryServiceTest({});

  // Approval-link config. Required in production (signing key must be
  // stable so links survive restarts), but we fall back to a dev key
  // when unset so the worker boots in tests / local dev. The signing
  // key is shared with apps/api so it can verify the same tokens.
  const approvalBaseUrl =
    process.env["APPROVAL_BASE_URL"] ?? "http://localhost:4000";
  const approvalSigningKey =
    process.env["APPROVAL_SIGNING_KEY"] ?? "dev-only-approval-key";
  const approvalLinkLayer = Layer.succeed(ApprovalLinkConfig, {
    baseUrl: approvalBaseUrl,
    signingKey: approvalSigningKey,
    // 30 days. Approvals are human-latency objects — a draft proposed on a
    // Friday must still be one-click approvable the following week. The row
    // never expires (there is no age-based expiry sweep), the token is a
    // bearer credential bound to a single approval id + action, and
    // `ApprovalService.approve` rejects already-decided rows — so a long-lived
    // link can only ever act on the one pending draft it was minted for.
    // Matches the "expire after 30 days" copy on the api's link pages.
    ttlMs: 30 * 24 * 60 * 60 * 1000,
  });

  // Conversation connector. The worker boots ONE `ConversationService`, but
  // each tenant connects their own mailbox, possibly on a different provider.
  // `ConversationRouterLive` resolves which connector a tenant installed (from
  // `connector_connections`) and delegates to the matching impl. We register
  // the builder for every connector this deployment has env for; adding
  // Outlook / IMAP means pushing another `[provider, make…Conversation(cfg)]`
  // pair below — tools, runtime, and agents stay untouched. When no connector
  // is configured we fall back to the in-memory Test layer so the worker still
  // boots for dev runs that only exercise non-mailbox surfaces.
  const googleClientId = process.env["GOOGLE_OAUTH_CLIENT_ID"];
  const googleClientSecret = process.env["GOOGLE_OAUTH_CLIENT_SECRET"];
  const msClientId = process.env["MICROSOFT_OAUTH_CLIENT_ID"];
  const msClientSecret = process.env["MICROSOFT_OAUTH_CLIENT_SECRET"];
  const msTenant = process.env["MICROSOFT_OAUTH_TENANT"];
  const connectorBuilders = [
    ...(googleClientId && googleClientSecret
      ? ([
          [
            "gmail",
            makeGmailConversation({
              clientId: googleClientId,
              clientSecret: googleClientSecret,
            }),
          ],
        ] as const)
      : []),
    ...(msClientId && msClientSecret
      ? ([
          [
            "outlook",
            makeGraphConversation({
              clientId: msClientId,
              clientSecret: msClientSecret,
              ...(msTenant ? { tenant: msTenant } : {}),
            }),
          ],
        ] as const)
      : []),
    // Generic IMAP/SMTP needs no platform OAuth env — only the per-tenant
    // credentials in the store — so it's always available once the store is
    // wired (credKeyB64 present).
    ...(credKeyB64
      ? ([["imap", makeImapSmtpConversation()]] as const)
      : []),
  ];
  // In production the in-memory fallback is forbidden outright (audit
  // L16): ConversationServiceTest "sends" replies into memory, the agent
  // resolves the ticket, and the customer receives nothing — a silent
  // outage. (Unreachable today because CREDENTIAL_ENCRYPTION_KEY is
  // already required in prod and the IMAP builder needs only that key,
  // but the hard fail keeps a future builder-gating change from quietly
  // reintroducing the no-op path.)
  if (isProd && !(credKeyB64 && connectorBuilders.length > 0)) {
    throw new Error(
      "[worker] no conversation connector configured in production — replies would silently no-op. Set CREDENTIAL_ENCRYPTION_KEY (and provider OAuth env for Gmail/Outlook).",
    );
  }
  const conversation =
    credKeyB64 && connectorBuilders.length > 0
      ? // The ticket-provider resolver (audit D2) routes a legacy
        // (un-namespaced) thread through the provider stamped on its
        // ticket before falling back to most-recently-installed — so
        // connecting a second mailbox no longer breaks open tickets.
        ConversationRouterLive(
          connectorBuilders,
          makeTicketProviderResolver,
        ).pipe(
          Layer.provide(
            Layer.mergeAll(
              ConnectorCredentialStoreLive(encryptionKeys!),
              TicketRepositoryLive.pipe(Layer.provide(dbLayer)),
              // Connectors read attachment blobs back to encode outbound
              // attachments (Gmail MIME / Graph fileAttachment / SMTP).
              blob,
            ),
          ),
        )
      : ConversationServiceTest({});

  // Sheets connector. Same gating as Gmail: when CREDENTIAL_ENCRYPTION_KEY
  // + Google OAuth env are set, swap in the Live layer that resolves
  // per-tenant tokens from `connector_connections`. Otherwise fall back
  // to an in-memory Test layer so the worker still boots — the
  // `supplier.add_sheet_row` tool will fail with `SheetsNotFound` if
  // invoked, but the rest of the runtime is unaffected.
  const sheets =
    credKeyB64 && googleClientId && googleClientSecret
      ? SheetsServiceLive({
          clientId: googleClientId,
          clientSecret: googleClientSecret,
        }).pipe(
          Layer.provide(ConnectorCredentialStoreLive(encryptionKeys!)),
        )
      : (warnProdFallback(
          "Google Sheets connector",
          "CREDENTIAL_ENCRYPTION_KEY + GOOGLE_OAUTH_CLIENT_ID/SECRET",
        ),
        SheetsServiceTest({}));

  // 17track tracking connector. Platform-managed credentials: a single
  // env var (`SEVENTEENTRACK_API_KEY`) gates the Live layer. When unset
  // the worker boots cleanly with the NoProvider fallback — every
  // `tracking.lookup` returns `{ kind: "no_provider" }` so agents fall
  // back to the public tracking URL in their replies. No per-tenant
  // connector row, no install flow.
  const trackingApiKey = process.env["SEVENTEENTRACK_API_KEY"];
  const tracking = trackingApiKey
    ? TrackingServiceLive.pipe(
        Layer.provide(
          Layer.succeed(TrackingConfig, { apiKey: trackingApiKey }),
        ),
      )
    : TrackingServiceNoProvider;

  // Permission policy with the conditional refund threshold + the
  // connector scope precheck layered on. Live impl consults
  // `TenantRepository` for `refundPolicy` and `ConnectorCredentialStore`
  // for granted scopes. Default `PermissionServiceDefault` is the
  // pure-static fallback used in unit tests; production wants the Live
  // layer.
  //
  // In single-tenant dev mode (no CREDENTIAL_ENCRYPTION_KEY), there's
  // no DB-backed connector store — the Shopify token comes straight
  // from env. We feed a synthetic permissive connector row so the
  // scope precheck doesn't deny everything in that mode; the dev's
  // env-supplied token already implicitly carries whatever scopes the
  // merchant granted, and we trust the operator who set the env.
  const connectorStoreForPermissions = credKeyB64
    ? ConnectorCredentialStoreLive(encryptionKeys!)
    : Layer.succeed(
        ConnectorCredentialStore,
        ConnectorCredentialStore.of({
          // Permission-only stub: returns a synthetic "Shopify with all
          // scopes" row for any tenant query, so the scope precheck
          // doesn't deny refund.create in single-tenant dev. The other
          // methods are never called by PermissionServiceLive — wire
          // them to fail loudly if anything else reaches for this Tag
          // in dev mode (which would indicate the bootstrap missed a
          // Layer slot).
          listForTenant: (tenantId) =>
            Effect.succeed([
              {
                tenantId,
                provider: "shopify",
                shopDomain: "dev",
                accessToken: "dev",
                refreshToken: null,
                tokenExpiresAt: null,
                metadata: {},
                scopes: [
                  "read_orders",
                  "read_customers",
                  "write_orders",
                  "write_discounts",
                ],
                apiVersion: null,
                installedAt: new Date(),
                status: "active",
              } satisfies ConnectorConnection,
            ]),
          get: () => Effect.die("dev-mode connector store: get() not wired"),
          put: () => Effect.die("dev-mode connector store: put() not wired"),
          revoke: () =>
            Effect.die("dev-mode connector store: revoke() not wired"),
          patchTokens: () =>
            Effect.die("dev-mode connector store: patchTokens() not wired"),
          patchMetadata: () =>
            Effect.die("dev-mode connector store: patchMetadata() not wired"),
        }),
      );
  const permissions = PermissionServiceLive.pipe(
    Layer.provide(
      Layer.mergeAll(TenantRepositoryLive, connectorStoreForPermissions),
    ),
  );

  // In-memory registries. AgentRegistryWith / ToolRegistryWith can fail
  // with AgentAlreadyRegistered / ToolAlreadyRegistered during Layer
  // build — that would be a programmer error (we control the input
  // list), so we promote it to a defect. The agent + tool lists come
  // from `ALL_AGENTS` / `ALL_TOOLS`: single source of truth, shared
  // with the dashboard's settings catalog. New agent? Add it to
  // `packages/agents/src/index.ts:ALL_AGENTS` exactly once.
  // Tenant-aware agent resolution: AgentResolverLive consumes the in-memory
  // built-in registry plus the DbClient-backed custom-agent store, so the
  // runtime resolves built-ins first and the tenant's custom agents second.
  // The built-in AgentRegistry is no longer exposed at the top level — only
  // the resolver consumes it. CustomAgentServiceLive needs DbClient, which the
  // envWithDb provide below satisfies.
  const agentResolver = AgentResolverLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.orDie(AgentRegistryWith(ALL_AGENTS)),
        CustomAgentServiceLive,
      ),
    ),
  );
  const registry = Layer.mergeAll(
    agentResolver,
    Layer.orDie(ToolRegistryWith(ALL_TOOLS)),
    permissions,
  );

  // env = everything the AgentRuntime AND the tool bodies need, except
  // DbClient (which we feed in via provide below). We expose env to the
  // outer fiber because tool.execute yields its own deps (TicketRepository,
  // ShopifyService) at call time — they are NOT consumed by
  // AgentRuntimeDefault itself; they're consumed inside the tools.
  const env = Layer.mergeAll(
    repos,
    registry,
    llm,
    shopify,
    sheets,
    tracking,
    conversation,
    mail,
    merchantNotifications,
    orgDirectory,
    approvalLinkLayer,
    blob,
    accountOpenrouterStore,
    // Duplicate-photo fraud guard. DbClient-backed; satisfied by the
    // dbLayer provide below. The runtime picks it up via serviceOption.
    ImageHashStoreLive,
    // Draft-attachment resolution: conversation.reply / ask_customer resolve
    // LLM-passed `attachmentIds` to storage keys through this store (tenant+
    // ticket scoped). DbClient-backed; satisfied by the dbLayer provide below.
    TicketAttachmentStoreLive,
    // Exposed at the top level (not just provided INTO consumers) so the
    // conversation-connector crons — imap-poll, gmail-watch-renewal,
    // graph-subscription-renewal — can resolve it directly against
    // `runtimeLayer`. Without this they Die with "Service not found:
    // ConnectorCredentialStore" on every pass (silently, until the
    // `as Effect<…, never>` casts that hid the missing requirement were
    // removed). DbClient-backed; satisfied by the dbLayer provide below.
    connectorStoreForPermissions,
  );

  // Satisfy env's DbClient dependency.
  const envWithDb = env.pipe(Layer.provide(dbLayer));

  // Build AgentRuntime against the satisfied env.
  const agentRuntime = AgentRuntimeDefault.pipe(Layer.provide(envWithDb));

  // Expose AgentRuntime + envWithDb + dbLayer so tools can resolve their
  // own deps when the runtime calls them.
  const runtimeLayer = Layer.mergeAll(agentRuntime, envWithDb, dbLayer);

  const shutdown = async () => {
    await boss.stop({ graceful: true });
  };

  return {
    boss,
    runtimeLayer,
    credentialEncryptionKeys: encryptionKeys,
    shutdown,
  };
};
