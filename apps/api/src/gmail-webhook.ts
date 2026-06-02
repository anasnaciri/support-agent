import { Effect, type Layer } from "effect";
import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import { and, eq } from "drizzle-orm";
import {
  BlobStorage,
  ConnectorCredentialStore,
  makeEnqueuedWorkflowEvent,
  type ConnectorConnection,
} from "@support-agent/services";
import {
  TenantId,
  type DomainEvent,
  type InboundMessage,
  type MessageAttachment,
} from "@support-agent/agent-core";
import {
  GmailHttpError,
  gmailGetMessage,
  gmailGetProfile,
  gmailListHistory,
  gmailListInboxMessageIds,
  gmailMarkMessageRead,
  processGmailImageAttachments,
  refreshGmailToken,
  toInboundMessage,
} from "@support-agent/providers";
import { connectorConnections, DbClient } from "@support-agent/db";
import type { ApiLayer, GoogleAppConfig } from "./bootstrap.js";

// ============================================================
// Pub/Sub envelope parsing
// ============================================================

interface PubSubPushEnvelope {
  readonly message?: {
    readonly data?: string;
    readonly messageId?: string;
    readonly publishTime?: string;
    readonly attributes?: Readonly<Record<string, string>>;
  };
  readonly subscription?: string;
}

interface GmailWatchPayload {
  readonly emailAddress: string;
  /** Always present; documented as a string in Google's docs. */
  readonly historyId: string;
}

export const parseGmailPushEnvelope = (
  raw: Buffer,
): GmailWatchPayload | null => {
  let envelope: PubSubPushEnvelope;
  try {
    envelope = JSON.parse(raw.toString("utf8")) as PubSubPushEnvelope;
  } catch {
    return null;
  }
  const data = envelope.message?.data;
  if (!data) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(data, "base64").toString("utf8");
  } catch {
    return null;
  }
  let payload: GmailWatchPayload;
  try {
    payload = JSON.parse(decoded) as GmailWatchPayload;
  } catch {
    return null;
  }
  if (!payload.emailAddress || !payload.historyId) return null;
  return payload;
};

// ============================================================
// pg-boss publisher
// ============================================================
//
// Local copy of the worker's helper. We don't reach into
// `@support-agent/worker` because cross-app private imports are fragile;
// the wire shape is small enough to keep in lockstep.

const WORKFLOW_QUEUE = "workflow.events";

let cachedBoss: PgBoss | null = null;
const acquireBoss = async (databaseUrl: string): Promise<PgBoss> => {
  if (cachedBoss) return cachedBoss;
  const boss = new PgBoss({ connectionString: databaseUrl, schema: "pgboss" });
  boss.on("error", (err: Error) => {
    // eslint-disable-next-line no-console
    console.error("[pg-boss] error", err);
  });
  await boss.start();
  await boss.createQueue(WORKFLOW_QUEUE, {
    policy: "key_strict_fifo",
    retryLimit: 5,
    retryBackoff: true,
  });
  cachedBoss = boss;
  return boss;
};

const defaultPublish = async (event: DomainEvent): Promise<void> => {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL must be set so the gmail webhook can publish message.received events",
    );
  }
  const boss = await acquireBoss(databaseUrl);
  const enqueued = makeEnqueuedWorkflowEvent(event, { eventId: randomUUID() });
  await boss.send(
    WORKFLOW_QUEUE,
    {
      eventId: enqueued.eventId,
      event: enqueued.event,
      key: enqueued.key,
      enqueuedAt: enqueued.enqueuedAt.toISOString(),
    },
    { singletonKey: enqueued.key },
  );
};

// ============================================================
// Push handler
// ============================================================

export interface GmailPushHandlerOptions {
  readonly tenantId: string;
  readonly rawBody: Buffer;
  readonly layer: ApiLayer;
  readonly google: GoogleAppConfig;
  /** Override for tests. Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /**
   * Hook to publish a normalised `message.received` event. The default
   * implementation opens a cached pg-boss connection lazily so tests can
   * inject a no-op or recorder.
   */
  readonly publish?: (event: DomainEvent) => Promise<void>;
}

const PROVIDER = "gmail" as const;

export type GmailConnectorLayer = Layer.Layer<
  ConnectorCredentialStore | BlobStorage,
  never,
  never
>;

export interface GmailMessageDispatchResult {
  readonly published: number;
  readonly skippedSent: number;
  readonly failed: number;
}

export interface GmailUnreadBackfillResult extends GmailMessageDispatchResult {
  readonly listed: number;
}

export const findTenantByGmailMailbox = (
  mailbox: string,
): Effect.Effect<string | null, Error, DbClient> =>
  Effect.gen(function* () {
    const db = yield* DbClient;
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({ tenantId: connectorConnections.tenantId })
          .from(connectorConnections)
          .where(
            and(
              eq(connectorConnections.provider, PROVIDER),
              eq(connectorConnections.shopDomain, mailbox),
              eq(connectorConnections.status, "active"),
            ),
          )
          .limit(1),
      catch: (cause) =>
        new Error(
          `findTenantByGmailMailbox select failed: ${String(cause)}`,
        ),
    });
    return rows[0]?.tenantId ?? null;
  });

const resolveBlobStorage = async (
  layer: GmailConnectorLayer,
  logPrefix: string,
): Promise<typeof BlobStorage.Service | null> => {
  const blobExit = await Effect.runPromiseExit(
    Effect.provide(
      Effect.gen(function* () {
        return yield* BlobStorage;
      }),
      layer,
    ),
  );
  if (blobExit._tag !== "Success") {
    // eslint-disable-next-line no-console
    console.error(`${logPrefix} BlobStorage resolve failed:`, blobExit.cause);
    return null;
  }
  return blobExit.value;
};

const publishGmailMessageIds = async (opts: {
  readonly tenantId: string;
  readonly accessToken: string;
  readonly messageIds: ReadonlyArray<string>;
  readonly layer: GmailConnectorLayer;
  readonly fetchImpl?: typeof fetch;
  readonly publish: (event: DomainEvent) => Promise<void>;
  readonly logPrefix: string;
}): Promise<GmailMessageDispatchResult> => {
  const blob = await resolveBlobStorage(opts.layer, opts.logPrefix);
  if (!blob) {
    return { published: 0, skippedSent: 0, failed: opts.messageIds.length };
  }

  let published = 0;
  let skippedSent = 0;
  let failed = 0;

  for (const messageId of opts.messageIds) {
    try {
      const msg = await gmailGetMessage({
        token: opts.accessToken,
        messageId,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      });
      // Skip messages we sent — outbound idempotency is handled upstream.
      if (msg.labelIds.includes("SENT")) {
        skippedSent += 1;
        continue;
      }
      let attachments: ReadonlyArray<MessageAttachment> = [];
      if (msg.imageAttachments.length > 0) {
        attachments = await processGmailImageAttachments({
          tenantId: TenantId(opts.tenantId),
          messageId,
          token: opts.accessToken,
          imageAttachments: msg.imageAttachments,
          blob,
          ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        });
      }
      const inbound: InboundMessage = toInboundMessage(msg, attachments);
      const event: DomainEvent = {
        type: "message.received",
        tenantId: TenantId(opts.tenantId),
        threadId: inbound.threadId,
        payload: inbound,
      };
      await opts.publish(event);
      published += 1;
      if (msg.labelIds.includes("UNREAD")) {
        try {
          await gmailMarkMessageRead({
            token: opts.accessToken,
            messageId,
            ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
          });
        } catch (cause) {
          // eslint-disable-next-line no-console
          console.error(
            `${opts.logPrefix} mark-read failed for messageId=${messageId}:`,
            cause,
          );
        }
      }
    } catch (cause) {
      failed += 1;
      // eslint-disable-next-line no-console
      console.error(
        `${opts.logPrefix} dispatch failed for messageId=${messageId}:`,
        cause,
      );
    }
  }

  return { published, skippedSent, failed };
};

export const backfillUnreadGmailInbox = async (opts: {
  readonly tenantId: string;
  readonly mailbox: string;
  readonly layer: GmailConnectorLayer;
  readonly fetchImpl?: typeof fetch;
  readonly publish?: (event: DomainEvent) => Promise<void>;
  readonly maxMessages?: number;
}): Promise<GmailUnreadBackfillResult> => {
  const conn = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const store = yield* ConnectorCredentialStore;
        return yield* store.get(TenantId(opts.tenantId), PROVIDER, opts.mailbox);
      }),
      opts.layer,
    ),
  );
  const messageIds = await gmailListInboxMessageIds({
    token: conn.accessToken,
    query: "in:inbox is:unread",
    maxResults: opts.maxMessages ?? 50,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  const publish = opts.publish ?? defaultPublish;
  const dispatched = await publishGmailMessageIds({
    tenantId: opts.tenantId,
    accessToken: conn.accessToken,
    messageIds,
    layer: opts.layer,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    publish,
    logPrefix: "[gmail unread backfill]",
  });
  return { listed: messageIds.length, ...dispatched };
};

/**
 * Process one Pub/Sub push delivery:
 *
 *   1. Parse envelope → `{ emailAddress, historyId }`.
 *   2. Resolve the connector_connections row for this tenant + mailbox.
 *      Revoked or missing → drop (uninstalled or never installed).
 *   3. Refresh access token if expired.
 *   4. `users.history.list?startHistoryId=<stored>` — the stored cursor
 *      is what we last successfully advanced to.
 *   5. For each new INBOX message: `users.messages.get` → normalise →
 *      publish `message.received`.
 *   6. Advance the stored `historyId` so the next push picks up after.
 *
 * Idempotency: history.list returns the same id range until we advance
 * the cursor, so retries re-publish the same payloads. Downstream is
 * responsible for dedup by `messageId` / `threadId`.
 */
export const handleGmailPushNotification = async (
  opts: GmailPushHandlerOptions,
): Promise<void> => {
  const payload = parseGmailPushEnvelope(opts.rawBody);
  if (!payload) {
    // eslint-disable-next-line no-console
    console.warn("[gmail webhook] unparseable push envelope; dropping");
    return;
  }

  const connExit = await Effect.runPromiseExit(
    Effect.provide(
      Effect.gen(function* () {
        const store = yield* ConnectorCredentialStore;
        return yield* store.get(
          TenantId(opts.tenantId),
          PROVIDER,
          payload.emailAddress,
        );
      }),
      opts.layer,
    ),
  );
  if (connExit._tag !== "Success") {
    // eslint-disable-next-line no-console
    console.warn(
      `[gmail webhook] no active connection for tenant=${opts.tenantId} mailbox=${payload.emailAddress}`,
    );
    return;
  }
  let conn: ConnectorConnection = connExit.value;

  if (
    conn.tokenExpiresAt === null ||
    conn.tokenExpiresAt.getTime() - 60_000 < Date.now()
  ) {
    if (!conn.refreshToken) {
      // eslint-disable-next-line no-console
      console.warn(
        `[gmail webhook] no refresh token for tenant=${opts.tenantId} mailbox=${payload.emailAddress}`,
      );
      return;
    }
    try {
      const refreshed = await refreshGmailToken({
        clientId: opts.google.clientId,
        clientSecret: opts.google.clientSecret,
        refreshToken: conn.refreshToken,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      });
      const patchExit = await Effect.runPromiseExit(
        Effect.provide(
          Effect.gen(function* () {
            const store = yield* ConnectorCredentialStore;
            return yield* store.patchTokens({
              tenantId: TenantId(opts.tenantId),
              provider: PROVIDER,
              shopDomain: payload.emailAddress,
              accessToken: refreshed.accessToken,
              tokenExpiresAt: refreshed.expiresAt,
            });
          }),
          opts.layer,
        ),
      );
      if (patchExit._tag !== "Success") {
        // eslint-disable-next-line no-console
        console.error(
          "[gmail webhook] token rotate failed:",
          patchExit.cause,
        );
        return;
      }
      conn = patchExit.value;
    } catch (cause) {
      // eslint-disable-next-line no-console
      console.error("[gmail webhook] refresh failed:", cause);
      return;
    }
  }

  // The cursor we keep advancing. Bootstrap from install-time metadata.
  // If absent (watch never registered), fall back to the push-delivered
  // historyId — we lose the very first window of mail but the next push
  // catches up.
  const storedHistoryId =
    typeof conn.metadata["historyId"] === "string"
      ? (conn.metadata["historyId"] as string)
      : payload.historyId;

  let listed: { newMessageIds: ReadonlyArray<string>; latestHistoryId: string | null };
  try {
    listed = await gmailListHistory({
      token: conn.accessToken,
      startHistoryId: storedHistoryId,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
  } catch (cause) {
    // Gmail returns 404 when `startHistoryId` is older than the ~7-day
    // history retention window. Recovery: list recent INBOX messages
    // directly (matching Gmail's window so nothing recoverable is left
    // on the table), publish each one, then snap the cursor forward to
    // the *current* mailbox historyId. The runtime's findByThreadId
    // dedup means re-published messages join their existing case
    // instead of opening duplicates.
    if (cause instanceof GmailHttpError && cause.failure.kind === "not_found") {
      // eslint-disable-next-line no-console
      console.warn(
        `[gmail webhook] history cursor expired for ${payload.emailAddress}; reseeding from messages.list`,
      );
      try {
        const reseedIds = await gmailListInboxMessageIds({
          token: conn.accessToken,
          query: "in:inbox newer_than:7d",
          maxResults: 50,
          ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        });
        const profile = await gmailGetProfile({
          token: conn.accessToken,
          ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        });
        listed = {
          newMessageIds: reseedIds,
          latestHistoryId: profile.historyId,
        };
      } catch (reseedCause) {
        // eslint-disable-next-line no-console
        console.error(
          "[gmail webhook] reseed failed:",
          reseedCause,
        );
        return;
      }
    } else {
      // eslint-disable-next-line no-console
      console.error("[gmail webhook] history.list failed:", cause);
      return;
    }
  }

  await publishGmailMessageIds({
    tenantId: opts.tenantId,
    accessToken: conn.accessToken,
    messageIds: listed.newMessageIds,
    layer: opts.layer,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    publish: opts.publish ?? defaultPublish,
    logPrefix: "[gmail webhook]",
  });

  const advanceTo = listed.latestHistoryId ?? payload.historyId;
  const patchExit = await Effect.runPromiseExit(
    Effect.provide(
      Effect.gen(function* () {
        const store = yield* ConnectorCredentialStore;
        return yield* store.patchMetadata({
          tenantId: TenantId(opts.tenantId),
          provider: PROVIDER,
          shopDomain: payload.emailAddress,
          metadata: { historyId: advanceTo },
        });
      }),
      opts.layer,
    ),
  );
  if (patchExit._tag !== "Success") {
    // eslint-disable-next-line no-console
    console.error(
      "[gmail webhook] historyId advance failed:",
      patchExit.cause,
    );
  }
};
