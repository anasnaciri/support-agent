import { Effect } from "effect";
import {
  lookup as dnsLookup,
  resolveMx as dnsResolveMx,
} from "node:dns/promises";
import { type FastifyReply, type FastifyRequest } from "fastify";
import {
  ConnectorCredentialStore,
  TenantRepository,
  type LLMProvider,
  type RefundPolicyMode,
} from "@support-agent/services";
import {
  ConnectorNotFound,
  ConnectorStoreDbError,
  TenantId,
} from "@support-agent/agent-core";
import {
  INSTALL_GRANT_TTL_MS,
  isInstallGrantProvider,
  signInstallGrant,
} from "../../auth/install-grant.js";
import { activeMailboxConflict } from "../connect/guard.js";
import {
  revokeConnectorGrant,
  makeImapSmtpOps,
  type ImapSmtpConfig,
  type ImapSmtpOps,
} from "@support-agent/providers";
import {
  parseImapConnectBody,
  imapConnectionMetadata,
} from "../mailbox/imap-connect.js";
import { discoverImapSettings, type DiscoveryIo } from "../mailbox/imap-discovery.js";
import {
  TELEGRAM_LINK_TTL_MS,
  mintTelegramLinkToken,
} from "../telegram/link.js";
import {
  type ApiConfig,
  type ApiLayer,
} from "../../bootstrap.js";
import {
  resolveTenantShopifyApp,
  sendShopifyAppResolveError,
} from "../shopify/handlers.js";
import {
  sendJson,
  opaqueCause,
  parseJsonBody,
} from "../../platform/http.js";
import {
  authenticateDashboard,
  tenantHasCurrentLegalAcceptance,
  sendLegalAcceptanceRequired,
} from "../../auth/dashboard-context.js";

const LLM_PROVIDER_SET: ReadonlySet<string> = new Set([
  "openrouter",
  "anthropic",
  "openai",
]);
export const isLlmProviderName = (p: string): p is LLMProvider =>
  LLM_PROVIDER_SET.has(p);

export const CONNECTOR_PROVIDERS = [
  "shopify",
  "gmail",
  "google_sheets",
  "outlook",
  "imap",
  "telegram",
] as const;
export type DisconnectProvider = (typeof CONNECTOR_PROVIDERS)[number];
export const isDisconnectProvider = (p: string): p is DisconnectProvider =>
  (CONNECTOR_PROVIDERS as ReadonlyArray<string>).includes(p);

// A1 reference with mandatory sheet-name prefix (mirrors the dashboard's
// supplier-escalation form validation).
export const SUPPLIER_RANGE_RE = /^[^!]+![A-Z]+\d*(:[A-Z]+\d*)?$/;

export const handleDashboardLlmConnect = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const body = parseJsonBody(req);
  const provider =
    typeof body["provider"] === "string" ? body["provider"].trim() : "";
  const apiKey = typeof body["apiKey"] === "string" ? body["apiKey"].trim() : "";
  const baseURL =
    typeof body["baseURL"] === "string" ? body["baseURL"].trim() : "";
  if (!isLlmProviderName(provider)) {
    return sendJson(res, 400, { error: "bad_provider" });
  }
  if (apiKey.length < 8) return sendJson(res, 400, { error: "missing_key" });
  if (!(await tenantHasCurrentLegalAcceptance(auth.tenantId, layer))) {
    return sendLegalAcceptanceRequired(res);
  }
  const tid = TenantId(auth.tenantId);
  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const store = yield* ConnectorCredentialStore;
        // At most one active LLM provider per tenant — revoke any existing
        // active LLM rows before the upsert (mirrors the dashboard action).
        const rows = yield* store.listForTenant(tid);
        const activeLlm = rows.filter(
          (r) => isLlmProviderName(r.provider) && r.status === "active",
        );
        yield* Effect.all(
          activeLlm.map((r) =>
            store.revoke(tid, r.provider as LLMProvider, r.shopDomain),
          ),
          { concurrency: 1 },
        );
        yield* store.put({
          tenantId: tid,
          provider,
          shopDomain: "default",
          accessToken: apiKey,
          scopes: [],
          ...(baseURL.length > 0
            ? { metadata: { baseURL } as Readonly<Record<string, unknown>> }
            : {}),
        });
      }),
      layer,
    ),
  );
  return sendJson(res, 200, { ok: true });
};

// POST /dashboard/llm/revoke — revoke the tenant's active LLM credential(s).
export const handleDashboardLlmRevoke = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const tid = TenantId(auth.tenantId);
  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const store = yield* ConnectorCredentialStore;
        const rows = yield* store.listForTenant(tid);
        const activeLlm = rows.filter(
          (r) => isLlmProviderName(r.provider) && r.status === "active",
        );
        yield* Effect.all(
          activeLlm.map((r) =>
            store.revoke(tid, r.provider as LLMProvider, r.shopDomain),
          ),
          { concurrency: 1 },
        );
      }),
      layer,
    ),
  );
  return sendJson(res, 200, { ok: true });
};

// POST /dashboard/refund-policy — set the tenant's conditional refund rule.
export const handleDashboardRefundPolicy = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const body = parseJsonBody(req);
  const currency =
    typeof body["currencyCode"] === "string"
      ? body["currencyCode"].trim().toUpperCase()
      : "";
  const ask = body["askAboveMinorUnits"];
  const deny = body["denyAboveMinorUnits"];
  const modeRaw = body["mode"];
  const mode: RefundPolicyMode =
    modeRaw === "always_ask" || modeRaw === "always_deny"
      ? modeRaw
      : "thresholds";
  if (!/^[A-Z]{3}$/.test(currency)) {
    return sendJson(res, 400, { error: "bad_currency" });
  }
  if (
    typeof ask !== "number" ||
    !Number.isInteger(ask) ||
    ask < 0 ||
    typeof deny !== "number" ||
    !Number.isInteger(deny) ||
    deny < 0
  ) {
    return sendJson(res, 400, { error: "bad_amount" });
  }
  if (ask > deny) return sendJson(res, 400, { error: "bad_order" });
  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const repo = yield* TenantRepository;
        yield* repo.setRefundPolicy(TenantId(auth.tenantId), {
          askAboveMinorUnits: ask,
          denyAboveMinorUnits: deny,
          currencyCode: currency,
          mode,
        });
      }),
      layer,
    ),
  );
  return sendJson(res, 200, { ok: true });
};

// POST /dashboard/supplier-sheet — set the missing-package escalation sheet.
export const handleDashboardSupplierSheet = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const body = parseJsonBody(req);
  const spreadsheetId =
    typeof body["spreadsheetId"] === "string"
      ? body["spreadsheetId"].trim()
      : "";
  const range = typeof body["range"] === "string" ? body["range"].trim() : "";
  const description =
    typeof body["description"] === "string" ? body["description"].trim() : "";
  if (!spreadsheetId) {
    return sendJson(res, 400, { error: "missing_spreadsheet_id" });
  }
  if (!SUPPLIER_RANGE_RE.test(range)) {
    return sendJson(res, 400, { error: "bad_range" });
  }
  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const repo = yield* TenantRepository;
        yield* repo.setSupplierEscalationSheet(TenantId(auth.tenantId), {
          spreadsheetId,
          range,
          description: description.length > 0 ? description : null,
        });
      }),
      layer,
    ),
  );
  return sendJson(res, 200, { ok: true });
};

// POST /dashboard/supplier-sheet/clear — clear the escalation sheet.
export const handleDashboardSupplierSheetClear = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const repo = yield* TenantRepository;
        yield* repo.setSupplierEscalationSheet(TenantId(auth.tenantId), null);
      }),
      layer,
    ),
  );
  return sendJson(res, 200, { ok: true });
};

// Revoke every active connector grant for a tenant+provider PROVIDER-SIDE
// (best-effort), THEN mark the rows revoked locally (5th-audit #3 — local
// revoke alone leaves the Shopify/Google token live). A provider-side failure
// is logged but doesn't block the local revoke (the caller asked to
// disconnect). Returns how many rows were revoked locally + how many were
// confirmed gone provider-side.
export const revokeConnectorProviderGrants = (
  tid: TenantId,
  provider: DisconnectProvider,
  tenantLabel: string,
): Effect.Effect<
  { readonly revoked: number; readonly providerRevoked: number },
  ConnectorNotFound | ConnectorStoreDbError,
  ConnectorCredentialStore
> =>
  Effect.gen(function* () {
    const store = yield* ConnectorCredentialStore;
    const rows = yield* store.listForTenant(tid);
    const active = rows.filter(
      (r) => r.provider === provider && r.status === "active",
    );
    let providerRevoked = 0;
    for (const r of active) {
      const result = yield* Effect.promise(() =>
        revokeConnectorGrant({
          provider,
          shopDomain: r.shopDomain,
          accessToken: r.accessToken,
          refreshToken: r.refreshToken,
          apiVersion: r.apiVersion,
        }),
      );
      if (result.kind === "revoked" || result.kind === "already_gone") {
        providerRevoked += 1;
      } else {
        // eslint-disable-next-line no-console
        console.error(
          `[disconnect] tenant=${tenantLabel} provider=${provider}/${r.shopDomain} provider-side revoke failed: ${result.detail}`,
        );
      }
    }
    yield* Effect.all(
      active.map((r) => store.revoke(tid, provider, r.shopDomain)),
      { concurrency: 1 },
    );
    return { revoked: active.length, providerRevoked };
  });

// POST /dashboard/connect/:provider — mint a signed, short-lived install
// grant for the AUTHENTICATED tenant and return the provider install URL
// (5th-audit #2). Authorization comes from the dashboard's bearer token +
// x-org-id (→ org→tenant), so the tenant is derived server-side from the
// session, never supplied by the client. The install endpoints then require
// this grant instead of a raw `?tenant=`.
export const handleDashboardConnect = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { provider } = req.params as { provider: string };
  if (!isInstallGrantProvider(provider)) {
    return sendJson(res, 400, { error: "bad_provider" });
  }
  // Shopify: refuse to mint a grant for a workspace with no resolvable app
  // (pilot workspace not provisioned / provisioning revoked / no app
  // configured at all). The install endpoint re-checks, but gating the mint
  // means the merchant is never sent into an OAuth flow that can only run on
  // credentials that don't belong to their workspace.
  if (provider === "shopify") {
    const app = await resolveTenantShopifyApp(cfg, layer, auth.tenantId);
    if (app.kind !== "ok") {
      sendShopifyAppResolveError(res, app);
      return res;
    }
  }
  // One mailbox per provider per store (same invariant as the IMAP connect
  // endpoint): refuse to start the OAuth flow while a mailbox is connected,
  // BEFORE the merchant sits through the consent screen. The callbacks
  // re-check for manual installs.
  if (provider === "gmail" || provider === "outlook") {
    const listExit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.gen(function* () {
          const store = yield* ConnectorCredentialStore;
          return yield* store.listForTenant(TenantId(auth.tenantId));
        }),
        layer,
      ),
    );
    if (listExit._tag !== "Success") {
      return sendJson(res, 500, {
        error: "persist_failed",
        detail: opaqueCause(listExit.cause),
      });
    }
    const conflict = activeMailboxConflict(listExit.value, provider);
    if (conflict) {
      return sendJson(res, 409, {
        error: "already_connected",
        provider,
        mailbox: conflict.shopDomain,
      });
    }
  }
  const grant = signInstallGrant(
    cfg.stateSigningKey,
    { tenantId: auth.tenantId, provider },
    Date.now() + INSTALL_GRANT_TTL_MS,
  );
  const apiOrigin = new URL(cfg.shopify.callbackUrl).origin;
  const path =
    provider === "shopify"
      ? "/shopify/install"
      : provider === "outlook"
        ? "/microsoft/install"
        : "/google/install";
  const url = `${apiOrigin}${path}?grant=${encodeURIComponent(grant)}`;
  return sendJson(res, 200, { url });
};

export const handleDashboardConnectImap = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
  opsFactory: (config: ImapSmtpConfig) => ImapSmtpOps = makeImapSmtpOps,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  if (!(await tenantHasCurrentLegalAcceptance(auth.tenantId, layer))) {
    return sendLegalAcceptanceRequired(res);
  }
  const parsed = parseImapConnectBody(parseJsonBody(req));
  if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });
  const { config, mailbox } = parsed.value;

  // One IMAP mailbox per store: replies resolve credentials per (tenant,
  // provider), so a second active mailbox could send from the wrong account.
  // Re-connecting the SAME mailbox stays allowed (upsert — password rotation,
  // host changes). The merchant must disconnect before switching mailboxes.
  const listExit = await Effect.runPromiseExit(
    Effect.provide(
      Effect.gen(function* () {
        const store = yield* ConnectorCredentialStore;
        return yield* store.listForTenant(TenantId(auth.tenantId));
      }),
      layer,
    ),
  );
  if (listExit._tag !== "Success") {
    return sendJson(res, 500, {
      error: "persist_failed",
      detail: opaqueCause(listExit.cause),
    });
  }
  const conflicting = listExit.value.find(
    (c) =>
      c.provider === "imap" &&
      c.status === "active" &&
      c.shopDomain.toLowerCase() !== mailbox.toLowerCase(),
  );
  if (conflicting) {
    return sendJson(res, 409, {
      error: "imap_already_connected",
      mailbox: conflicting.shopDomain,
    });
  }

  // Fail closed if we can't actually log in — better a 400 now than a
  // silently-dead connector that only errors when the agent tries to reply.
  try {
    await opsFactory(config).verify();
  } catch (cause) {
    return sendJson(res, 400, {
      error: "imap_connect_failed",
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  }

  const putExit = await Effect.runPromiseExit(
    Effect.provide(
      Effect.gen(function* () {
        const store = yield* ConnectorCredentialStore;
        return yield* store.put({
          tenantId: TenantId(auth.tenantId),
          provider: "imap",
          shopDomain: mailbox,
          accessToken: config.password,
          refreshToken: null,
          tokenExpiresAt: null,
          scopes: [],
          metadata: imapConnectionMetadata(config),
        });
      }),
      layer,
    ),
  );
  if (putExit._tag !== "Success") {
    return sendJson(res, 500, {
      error: "persist_failed",
      detail: opaqueCause(putExit.cause),
    });
  }
  return sendJson(res, 200, { ok: true, provider: "imap", mailbox });
};

// Live IO for IMAP/SMTP autodiscovery. The only HTTP target is the fixed,
// trusted ISPDB host (the merchant-controlled domain is hostname-validated
// before interpolation, see imap-discovery.ts) and the DNS legs return data
// we never connect to here — discovered hosts come back as form prefill and
// get the same verify-before-save treatment as merchant-typed ones.
const liveDiscoveryIo: DiscoveryIo = {
  fetchText: async (url) => {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(4_000),
        headers: { accept: "text/xml,application/xml" },
      });
      return res.ok ? await res.text() : null;
    } catch {
      return null;
    }
  },
  resolveMx: (domain) => dnsResolveMx(domain),
  hostExists: async (host) => {
    try {
      return (await dnsLookup(host, { all: true })).length > 0;
    } catch {
      return false;
    }
  },
};

// POST /dashboard/connections/imap/discover — find a mailbox's server
// settings from just the address, so the connect form can hide the
// host/port fields from non-technical merchants. Read-only (nothing is
// persisted), hence no legal-acceptance gate; authorization is the
// dashboard session.
export const handleDashboardImapDiscover = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
  io: DiscoveryIo = liveDiscoveryIo,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const email = parseJsonBody(req)["email"];
  if (typeof email !== "string" || email.trim().length === 0) {
    return sendJson(res, 400, { error: "missing_email" });
  }
  return sendJson(res, 200, await discoverImapSettings(email.trim(), io));
};

// POST /dashboard/connections/:provider/disconnect — revoke a connector.
export const handleDashboardDisconnect = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { provider } = req.params as { provider: string };
  if (!isDisconnectProvider(provider)) {
    return sendJson(res, 400, { error: "bad_provider" });
  }
  const outcome = await Effect.runPromise(
    Effect.provide(
      revokeConnectorProviderGrants(
        TenantId(auth.tenantId),
        provider,
        auth.tenantId,
      ),
      layer,
    ),
  );
  return sendJson(res, 200, outcome);
};

// POST /dashboard/connections/telegram — mint a signed Telegram linking
// deep link for the AUTHENTICATED tenant. No credentials change hands
// here: the merchant taps the t.me link, presses Start, and the bot
// webhook binds their chat via the signed token (never a raw tenant id).
export const handleDashboardConnectTelegram = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  if (!(await tenantHasCurrentLegalAcceptance(auth.tenantId, layer))) {
    return sendLegalAcceptanceRequired(res);
  }
  if (!cfg.telegram) {
    return sendJson(res, 503, { error: "telegram_not_configured" });
  }
  const expiresAtMs = Date.now() + TELEGRAM_LINK_TTL_MS;
  const token = mintTelegramLinkToken(
    cfg.stateSigningKey,
    auth.tenantId,
    expiresAtMs,
  );
  return sendJson(res, 200, {
    url: `https://t.me/${cfg.telegram.botUsername}?start=${token}`,
    expiresAt: new Date(expiresAtMs).toISOString(),
  });
};
