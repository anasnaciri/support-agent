// ============================================================
// Microsoft Graph subscription-renewal cron
// ============================================================
//
// Graph mail subscriptions expire fast (≈3 days max). Past the lease, Graph
// silently stops posting change notifications — the mailbox goes dark for
// inbound with no error. This job walks every active Outlook connector and
// renews (PATCH) the subscription before it lapses — or creates one (POST)
// for connectors installed before the webhook existed.
//
// Scheduled in `apps/worker/src/index.ts` via
// `boss.schedule("graph.subscription-renewal", "0 */6 * * *")`.

import { Effect } from "effect";
import { and, eq } from "drizzle-orm";
import {
  ConnectorCredentialStore,
  type ConnectorConnection,
} from "@support-agent/services";
import { TenantId } from "@support-agent/agent-core";
import {
  GRAPH_INBOX_RESOURCE,
  GRAPH_JUNK_RESOURCE,
  GRAPH_SUBSCRIPTION_TTL_MS,
  graphCreateSubscription,
  graphRenewSubscription,
  refreshGraphToken,
} from "@support-agent/providers";
import {
  DbClient,
  connectorConnections,
  type ConnectorConnectionRow,
} from "@support-agent/db";

// Renew at T-24h: with a 6h cron that's a 4-fire window inside the margin.
const RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface RenewActiveGraphSubscriptionsDeps {
  readonly microsoft: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly tenant: string;
    /** Base notification URL; the per-tenant `/:tenantId` segment is appended. */
    readonly notificationUrl: string;
    readonly webhookClientState: string;
  };
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}

export interface GraphRenewalResult {
  readonly tenantId: string;
  readonly mailbox: string;
  readonly outcome:
    | "renewed"
    | "created"
    | "skipped_not_due"
    | "skipped_no_refresh_token"
    | { readonly failed: string };
}

// Each mailbox carries one subscription per watched folder: the Inbox
// (original) and Junk Email (spam is ingested, not filtered). Slots keep
// their own metadata keys; the inbox slot keeps the pre-junk key names so
// existing connectors renew in place, and connectors without the junk keys
// get that subscription created on the next cron fire.
interface SubscriptionSlot {
  readonly resource: string;
  readonly idKey: string;
  readonly expiresKey: string;
}

const SUBSCRIPTION_SLOTS: ReadonlyArray<SubscriptionSlot> = [
  {
    resource: GRAPH_INBOX_RESOURCE,
    idKey: "subscriptionId",
    expiresKey: "subscriptionExpiresAt",
  },
  {
    resource: GRAPH_JUNK_RESOURCE,
    idKey: "junkSubscriptionId",
    expiresKey: "junkSubscriptionExpiresAt",
  },
];

const subscriptionExpiryFromMetadata = (
  metadata: Readonly<Record<string, unknown>>,
  key: string,
): Date | null => {
  const raw = metadata[key];
  if (typeof raw !== "string") return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t) : null;
};

const subscriptionIdFromMetadata = (
  metadata: Readonly<Record<string, unknown>>,
  key: string,
): string | null => {
  const raw = metadata[key];
  return typeof raw === "string" && raw ? raw : null;
};

const slotIsDue = (
  metadata: Readonly<Record<string, unknown>>,
  slot: SubscriptionSlot,
  now: Date,
): boolean => {
  const id = subscriptionIdFromMetadata(metadata, slot.idKey);
  const expiresAt = subscriptionExpiryFromMetadata(metadata, slot.expiresKey);
  // Due unless we HAVE a live subscription comfortably in lease. A missing
  // id means "never created" → create it now.
  return !(
    id &&
    expiresAt !== null &&
    expiresAt.getTime() - now.getTime() > RENEWAL_WINDOW_MS
  );
};

/** Narrow store surface `renewOne` needs (lets tests pass a plain object). */
export interface GraphRenewalStoreOps {
  readonly patchTokens: (input: {
    tenantId: string;
    accessToken: string;
    tokenExpiresAt: Date;
    refreshToken?: string | null;
  }) => Promise<void>;
  readonly patchMetadata: (input: {
    tenantId: string;
    shopDomain: string;
    metadata: Readonly<Record<string, unknown>>;
  }) => Promise<void>;
}

export const renewOne = async (
  conn: ConnectorConnection,
  deps: RenewActiveGraphSubscriptionsDeps,
  store: GraphRenewalStoreOps,
  now: Date,
): Promise<GraphRenewalResult> => {
  const dueSlots = SUBSCRIPTION_SLOTS.filter((slot) =>
    slotIsDue(conn.metadata, slot, now),
  );
  if (dueSlots.length === 0) {
    return {
      tenantId: conn.tenantId,
      mailbox: conn.shopDomain,
      outcome: "skipped_not_due",
    };
  }
  if (!conn.refreshToken) {
    return {
      tenantId: conn.tenantId,
      mailbox: conn.shopDomain,
      outcome: "skipped_no_refresh_token",
    };
  }

  let accessToken = conn.accessToken;
  if (
    conn.tokenExpiresAt === null ||
    conn.tokenExpiresAt.getTime() - 60_000 < now.getTime()
  ) {
    try {
      const refreshed = await refreshGraphToken({
        clientId: deps.microsoft.clientId,
        clientSecret: deps.microsoft.clientSecret,
        refreshToken: conn.refreshToken,
        tenant: deps.microsoft.tenant,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      });
      await store.patchTokens({
        tenantId: conn.tenantId,
        accessToken: refreshed.accessToken,
        tokenExpiresAt: refreshed.expiresAt,
        refreshToken: refreshed.refreshToken,
      });
      accessToken = refreshed.accessToken;
    } catch (cause) {
      return {
        tenantId: conn.tenantId,
        mailbox: conn.shopDomain,
        outcome: {
          failed: `refresh: ${cause instanceof Error ? cause.message : String(cause)}`,
        },
      };
    }
  }

  const newExpiry = new Date(now.getTime() + GRAPH_SUBSCRIPTION_TTL_MS).toISOString();
  const failures: Array<string> = [];
  let created = 0;
  let renewed = 0;
  for (const slot of dueSlots) {
    const subscriptionId = subscriptionIdFromMetadata(conn.metadata, slot.idKey);
    try {
      if (subscriptionId) {
        const sub = await graphRenewSubscription({
          token: accessToken,
          subscriptionId,
          expirationDateTime: newExpiry,
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        });
        await store.patchMetadata({
          tenantId: conn.tenantId,
          shopDomain: conn.shopDomain,
          metadata: { [slot.expiresKey]: sub.expirationDateTime },
        });
        renewed += 1;
        continue;
      }
      const notificationUrl = `${deps.microsoft.notificationUrl.replace(/\/+$/, "")}/${encodeURIComponent(conn.tenantId)}`;
      const sub = await graphCreateSubscription({
        token: accessToken,
        notificationUrl,
        clientState: deps.microsoft.webhookClientState,
        expirationDateTime: newExpiry,
        resource: slot.resource,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      });
      await store.patchMetadata({
        tenantId: conn.tenantId,
        shopDomain: conn.shopDomain,
        metadata: {
          [slot.idKey]: sub.id,
          [slot.expiresKey]: sub.expirationDateTime,
        },
      });
      created += 1;
    } catch (cause) {
      failures.push(
        `subscription(${slot.resource}): ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
  if (failures.length > 0) {
    return {
      tenantId: conn.tenantId,
      mailbox: conn.shopDomain,
      outcome: { failed: failures.join("; ") },
    };
  }
  return {
    tenantId: conn.tenantId,
    mailbox: conn.shopDomain,
    outcome: created > 0 ? "created" : "renewed",
  };
};

/** One renewal pass over every active Outlook connector. */
export const renewActiveGraphSubscriptions = (
  deps: RenewActiveGraphSubscriptionsDeps,
): Effect.Effect<
  ReadonlyArray<GraphRenewalResult>,
  unknown,
  DbClient | ConnectorCredentialStore
> =>
  Effect.gen(function* () {
    const db = yield* DbClient;
    const store = yield* ConnectorCredentialStore;
    const now = (deps.now ?? (() => new Date()))();

    const rows: ReadonlyArray<ConnectorConnectionRow> = yield* Effect.tryPromise({
      try: () =>
        db
          .select()
          .from(connectorConnections)
          .where(
            and(
              eq(connectorConnections.provider, "outlook"),
              eq(connectorConnections.status, "active"),
            ),
          ),
      catch: (cause) =>
        new Error(`graph-subscription-renewal select: ${String(cause)}`),
    });

    const rowsByTenant = new Map<string, ConnectorConnectionRow>();
    for (const r of rows) rowsByTenant.set(r.tenantId, r);

    const storeOps: GraphRenewalStoreOps = {
      patchTokens: (input) =>
        Effect.runPromise(
          store
            .patchTokens({
              tenantId: TenantId(input.tenantId),
              provider: "outlook",
              shopDomain: rowsByTenant.get(input.tenantId)?.shopDomain ?? "",
              accessToken: input.accessToken,
              tokenExpiresAt: input.tokenExpiresAt,
              ...(input.refreshToken != null
                ? { refreshToken: input.refreshToken }
                : {}),
            })
            .pipe(
              Effect.map(() => undefined as void),
              Effect.catchAll((cause) =>
                Effect.fail(new Error(`patchTokens: ${String(cause)}`)),
              ),
            ),
        ),
      patchMetadata: (input) =>
        Effect.runPromise(
          store
            .patchMetadata({
              tenantId: TenantId(input.tenantId),
              provider: "outlook",
              shopDomain: input.shopDomain,
              metadata: input.metadata,
            })
            .pipe(
              Effect.map(() => undefined as void),
              Effect.catchAll((cause) =>
                Effect.fail(new Error(`patchMetadata: ${String(cause)}`)),
              ),
            ),
        ),
    };

    const results: Array<GraphRenewalResult> = [];
    for (const row of rows) {
      const conn = yield* store
        .get(TenantId(row.tenantId), "outlook", row.shopDomain)
        .pipe(
          Effect.either,
          Effect.map((either) =>
            either._tag === "Right" ? either.right : null,
          ),
        );
      if (!conn) continue;
      const result = yield* Effect.tryPromise({
        try: () => renewOne(conn, deps, storeOps, now),
        catch: (cause): GraphRenewalResult => ({
          tenantId: row.tenantId,
          mailbox: row.shopDomain,
          outcome: {
            failed: cause instanceof Error ? cause.message : String(cause),
          },
        }),
      }).pipe(
        Effect.either,
        Effect.map((either) =>
          either._tag === "Right"
            ? either.right
            : ({
                tenantId: row.tenantId,
                mailbox: row.shopDomain,
                outcome: { failed: String(either.left) },
              } as GraphRenewalResult),
        ),
      );
      results.push(result);
    }
    return results;
  });
