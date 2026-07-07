// ============================================================
// Gmail `users.watch` renewal cron
// ============================================================
//
// Gmail's watch subscription has a hard ~7-day lease — past that, Gmail
// silently stops publishing notifications to the Pub/Sub topic. The
// failure mode is invisible: no error, no message, just a mailbox that
// goes dark for inbound. This job walks every active Gmail connector and
// re-registers the watch before the lease expires.
//
// Scheduled in `apps/worker/src/index.ts` via
// `boss.schedule("gmail.watch-renewal", "0 */6 * * *")` — every 6 hours,
// which gives 4 retry windows inside the safety margin (24h) before any
// lease would have actually expired.

import { Effect } from "effect";
import { and, eq } from "drizzle-orm";
import {
  ConnectorCredentialStore,
  type ConnectorConnection,
} from "@support-agent/services";
import { TenantId } from "@support-agent/agent-core";
import {
  refreshGmailToken,
  startGmailWatch,
} from "@support-agent/providers";
import {
  DbClient,
  connectorConnections,
  type ConnectorConnectionRow,
} from "@support-agent/db";

// Renew at T-24h: gives a 4-fire window (every 6h) inside the safety
// margin so a single missed run doesn't cost us the lease.
const RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface RenewActiveGmailWatchesDeps {
  readonly google: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly pubsubTopic: string;
  };
  /** Override for tests. Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Defaults to `() => new Date()` — overrideable for deterministic tests. */
  readonly now?: () => Date;
}

export interface RenewalResult {
  readonly tenantId: string;
  readonly mailbox: string;
  readonly outcome:
    | "renewed"
    | "skipped_not_due"
    | "skipped_no_refresh_token"
    | { readonly failed: string };
}

const watchExpiresAtFromMetadata = (
  metadata: Readonly<Record<string, unknown>>,
): Date | null => {
  const raw = metadata["watchExpiresAt"];
  if (typeof raw !== "string") return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t) : null;
};

// The label set `startGmailWatch` registers by default. Persisted alongside
// the lease so we can tell watches that predate SPAM ingestion (no marker)
// apart from current ones — those are re-registered immediately instead of
// staying INBOX-only until their ~7-day lease runs down.
const CURRENT_WATCH_LABEL_IDS = ["INBOX", "SPAM"] as const;

const watchCoversSpam = (
  metadata: Readonly<Record<string, unknown>>,
): boolean => {
  const raw = metadata["watchLabelIds"];
  return Array.isArray(raw) && raw.includes("SPAM");
};

/**
 * Narrow surface of `ConnectorCredentialStore` that `renewOne` needs.
 * Letting the unit test pass a hand-rolled object instead of standing up
 * the full Tag layer.
 */
export interface RenewalStoreOps {
  readonly patchTokens: (input: {
    tenantId: string;
    accessToken: string;
    tokenExpiresAt: Date;
  }) => Promise<void>;
  readonly patchMetadata: (input: {
    tenantId: string;
    shopDomain: string;
    metadata: Readonly<Record<string, unknown>>;
  }) => Promise<void>;
}

export const renewOne = async (
  conn: ConnectorConnection,
  deps: RenewActiveGmailWatchesDeps,
  store: RenewalStoreOps,
  now: Date,
): Promise<RenewalResult> => {
  const watchExpiresAt = watchExpiresAtFromMetadata(conn.metadata);
  // Skip rows where the lease is still comfortably alive AND the watch
  // already covers SPAM. `null` expiry means we never registered a watch
  // (or it predates metadata persisting expiry); a missing/INBOX-only
  // label marker means the watch predates spam ingestion. Both are
  // treated as due-for-renewal.
  if (
    watchExpiresAt !== null &&
    watchExpiresAt.getTime() - now.getTime() > RENEWAL_WINDOW_MS &&
    watchCoversSpam(conn.metadata)
  ) {
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
  // Refresh the token if it's expired or close to. Otherwise `users.watch`
  // could fail with 401 and waste this cycle.
  if (
    conn.tokenExpiresAt === null ||
    conn.tokenExpiresAt.getTime() - 60_000 < now.getTime()
  ) {
    try {
      const refreshed = await refreshGmailToken({
        clientId: deps.google.clientId,
        clientSecret: deps.google.clientSecret,
        refreshToken: conn.refreshToken,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      });
      await store.patchTokens({
        tenantId: conn.tenantId,
        accessToken: refreshed.accessToken,
        tokenExpiresAt: refreshed.expiresAt,
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

  try {
    const watch = await startGmailWatch({
      accessToken,
      topicName: deps.google.pubsubTopic,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
    await store.patchMetadata({
      tenantId: conn.tenantId,
      shopDomain: conn.shopDomain,
      metadata: {
        historyId: watch.historyId,
        watchExpiresAt: watch.expiresAt.toISOString(),
        watchLabelIds: [...CURRENT_WATCH_LABEL_IDS],
      },
    });
    return {
      tenantId: conn.tenantId,
      mailbox: conn.shopDomain,
      outcome: "renewed",
    };
  } catch (cause) {
    return {
      tenantId: conn.tenantId,
      mailbox: conn.shopDomain,
      outcome: {
        failed: `watch: ${cause instanceof Error ? cause.message : String(cause)}`,
      },
    };
  }
};

/**
 * One renewal pass. Returns per-mailbox outcomes for observability
 * (logged at the call site; nothing else consumes the structured form
 * today, but tests assert against it).
 */
export const renewActiveGmailWatches = (
  deps: RenewActiveGmailWatchesDeps,
): Effect.Effect<
  ReadonlyArray<RenewalResult>,
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
              eq(connectorConnections.provider, "gmail"),
              eq(connectorConnections.status, "active"),
            ),
          ),
      catch: (cause) => new Error(`gmail-watch-renewal select: ${String(cause)}`),
    });

    // Build a small lookup so `patchTokens` (whose narrow ops surface
    // doesn't carry shopDomain) can resolve it back to a connector row.
    const rowsByTenant = new Map<string, ConnectorConnectionRow>();
    for (const r of rows) rowsByTenant.set(r.tenantId, r);

    // Bridge from the Effect-shaped store Tag onto the narrow Promise-
    // shaped ops `renewOne` expects. Each patch becomes its own
    // `runPromise`; failures bubble back via the renewOne catch clause.
    const storeOps: RenewalStoreOps = {
      patchTokens: (input) =>
        Effect.runPromise(
          store
            .patchTokens({
              tenantId: TenantId(input.tenantId),
              provider: "gmail",
              shopDomain: rowsByTenant.get(input.tenantId)?.shopDomain ?? "",
              accessToken: input.accessToken,
              tokenExpiresAt: input.tokenExpiresAt,
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
              provider: "gmail",
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

    const results: Array<RenewalResult> = [];
    for (const row of rows) {
      // Re-resolve through the store so the access token is decrypted
      // and any concurrent token rotation is observed (the row we have
      // here is a snapshot from the SELECT above).
      const conn = yield* store
        .get(TenantId(row.tenantId), "gmail", row.shopDomain)
        .pipe(
          Effect.either,
          Effect.map((either) =>
            either._tag === "Right" ? either.right : null,
          ),
        );
      if (!conn) {
        // Revoked between SELECT and now — skip.
        continue;
      }
      const result = yield* Effect.tryPromise({
        try: () => renewOne(conn, deps, storeOps, now),
        catch: (cause): RenewalResult => ({
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
              } as RenewalResult),
        ),
      );
      results.push(result);
    }
    return results;
  });
