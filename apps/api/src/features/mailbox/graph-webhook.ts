import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import {
  ConnectorCredentialStore,
  makeEnqueuedWorkflowEvent,
  namespaceThreadId,
  type ConnectorConnection,
} from "@support-agent/services";
import {
  TenantId,
  type DomainEvent,
  type InboundMessage,
} from "@support-agent/agent-core";
import {
  graphGetMessage,
  refreshGraphToken,
  toInboundMessage,
} from "@support-agent/providers";
import type { ApiLayer, MicrosoftAppConfig } from "../../bootstrap.js";

const PROVIDER = "outlook" as const;

// ============================================================
// Validation handshake + notification parsing
// ============================================================
//
// Graph validates a new subscription's notificationUrl by POSTing with a
// `?validationToken=…` query; we must echo the decoded token back as
// text/plain with 200 within 10s. Real notifications arrive as a JSON body.

export const parseGraphValidationToken = (
  query: Readonly<Record<string, string | undefined>>,
): string | null => query["validationToken"] ?? query["validationtoken"] ?? null;

export interface GraphChangeNotification {
  readonly subscriptionId: string;
  readonly clientState: string | null;
  readonly resource: string | null;
  readonly resourceId: string | null;
  readonly changeType: string | null;
}

interface RawNotificationEnvelope {
  readonly value?: ReadonlyArray<{
    readonly subscriptionId?: string;
    readonly clientState?: string;
    readonly resource?: string;
    readonly changeType?: string;
    readonly resourceData?: { readonly id?: string };
  }>;
}

export const parseGraphNotifications = (
  raw: Buffer,
): ReadonlyArray<GraphChangeNotification> => {
  let envelope: RawNotificationEnvelope;
  try {
    envelope = JSON.parse(raw.toString("utf8")) as RawNotificationEnvelope;
  } catch {
    return [];
  }
  return (envelope.value ?? []).map((n) => ({
    subscriptionId: n.subscriptionId ?? "",
    clientState: n.clientState ?? null,
    resource: n.resource ?? null,
    resourceId: n.resourceData?.id ?? null,
    changeType: n.changeType ?? null,
  }));
};

// ============================================================
// pg-boss publisher (local copy; see gmail-webhook.ts for rationale)
// ============================================================

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
      "DATABASE_URL must be set so the outlook webhook can publish message.received events",
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
// Notification handler
// ============================================================

export interface GraphNotificationHandlerOptions {
  readonly tenantId: string;
  readonly notifications: ReadonlyArray<GraphChangeNotification>;
  readonly layer: ApiLayer;
  readonly microsoft: MicrosoftAppConfig;
  readonly fetchImpl?: typeof fetch;
  readonly publish?: (event: DomainEvent) => Promise<void>;
}

export interface GraphNotificationResult {
  readonly published: number;
  readonly skippedOutbound: number;
  readonly rejectedClientState: number;
  readonly failed: number;
}

/**
 * Process Graph change notifications: verify each one's `clientState` against
 * our shared secret, resolve the tenant's Outlook connection (refreshing the
 * access token when stale, persisting Microsoft's rotated refresh token),
 * fetch the referenced message, and publish a `message.received` for inbound
 * mail. Messages we sent are skipped (direction "outbound").
 */
export const handleGraphNotification = async (
  opts: GraphNotificationHandlerOptions,
): Promise<GraphNotificationResult> => {
  const publish = opts.publish ?? defaultPublish;
  let published = 0;
  let skippedOutbound = 0;
  let rejectedClientState = 0;
  let failed = 0;

  // Authenticate the batch BEFORE any token work (audit S4). clientState
  // is the only authentication this endpoint has, so:
  //   - with no configured secret we fail CLOSED (previously the check
  //     was skipped entirely, letting anyone who guessed a tenant id
  //     drive message fetches), and
  //   - notifications that fail the check are dropped here, before the
  //     token resolve/refresh below — otherwise a forged unauthenticated
  //     POST forces a refresh-token rotation on every request (a
  //     refresh-churn DoS against the tenant's mailbox connection).
  const secret = opts.microsoft.webhookClientState;
  if (!secret) {
    // eslint-disable-next-line no-console
    console.error(
      "[outlook webhook] MICROSOFT_GRAPH_WEBHOOK_SECRET is not configured — rejecting all notifications (fail closed)",
    );
    return {
      published: 0,
      skippedOutbound: 0,
      rejectedClientState: opts.notifications.length,
      failed: 0,
    };
  }
  const authenticated: GraphChangeNotification[] = [];
  for (const n of opts.notifications) {
    if (n.clientState !== secret) {
      rejectedClientState += 1;
    } else {
      authenticated.push(n);
    }
  }
  if (authenticated.length === 0) {
    return { published, skippedOutbound, rejectedClientState, failed };
  }

  // Resolve + refresh the tenant's Outlook token once for the batch.
  const connExit = await Effect.runPromiseExit(
    Effect.provide(
      Effect.gen(function* () {
        const store = yield* ConnectorCredentialStore;
        return yield* store.get(TenantId(opts.tenantId), PROVIDER);
      }),
      opts.layer,
    ),
  );
  if (connExit._tag !== "Success") {
    // eslint-disable-next-line no-console
    console.warn(
      `[outlook webhook] no active connection for tenant=${opts.tenantId}`,
    );
    return { published: 0, skippedOutbound: 0, rejectedClientState, failed: authenticated.length };
  }
  let conn: ConnectorConnection = connExit.value;

  if (
    conn.tokenExpiresAt === null ||
    conn.tokenExpiresAt.getTime() - 60_000 < Date.now()
  ) {
    if (!conn.refreshToken) {
      // eslint-disable-next-line no-console
      console.warn(`[outlook webhook] no refresh token for tenant=${opts.tenantId}`);
      return { published: 0, skippedOutbound: 0, rejectedClientState, failed: authenticated.length };
    }
    try {
      const refreshed = await refreshGraphToken({
        clientId: opts.microsoft.clientId,
        clientSecret: opts.microsoft.clientSecret,
        refreshToken: conn.refreshToken,
        tenant: opts.microsoft.tenant,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      });
      const patchExit = await Effect.runPromiseExit(
        Effect.provide(
          Effect.gen(function* () {
            const store = yield* ConnectorCredentialStore;
            return yield* store.patchTokens({
              tenantId: TenantId(opts.tenantId),
              provider: PROVIDER,
              shopDomain: conn.shopDomain,
              accessToken: refreshed.accessToken,
              tokenExpiresAt: refreshed.expiresAt,
              ...(refreshed.refreshToken !== null
                ? { refreshToken: refreshed.refreshToken }
                : {}),
            });
          }),
          opts.layer,
        ),
      );
      if (patchExit._tag !== "Success") {
        // eslint-disable-next-line no-console
        console.error("[outlook webhook] token rotate failed:", patchExit.cause);
        return { published: 0, skippedOutbound: 0, rejectedClientState, failed: authenticated.length };
      }
      conn = patchExit.value;
    } catch (cause) {
      // eslint-disable-next-line no-console
      console.error("[outlook webhook] refresh failed:", cause);
      return { published: 0, skippedOutbound: 0, rejectedClientState, failed: authenticated.length };
    }
  }

  for (const n of authenticated) {
    if (!n.resourceId) {
      failed += 1;
      continue;
    }
    try {
      const msg = await graphGetMessage({
        token: conn.accessToken,
        messageId: n.resourceId,
        mailbox: conn.shopDomain,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      });
      if (msg.direction === "outbound") {
        skippedOutbound += 1;
        continue;
      }
      // Namespace the thread id so the conversation router replies through
      // this same connector (a tenant can hold several mailboxes at once).
      const inbound: InboundMessage = {
        ...toInboundMessage(msg),
        threadId: namespaceThreadId(PROVIDER, msg.threadId),
        mailbox: conn.shopDomain,
      };
      const event: DomainEvent = {
        type: "message.received",
        tenantId: TenantId(opts.tenantId),
        threadId: inbound.threadId,
        payload: inbound,
      };
      await publish(event);
      published += 1;
    } catch (cause) {
      failed += 1;
      // eslint-disable-next-line no-console
      console.error(
        `[outlook webhook] dispatch failed for messageId=${n.resourceId}:`,
        cause,
      );
    }
  }

  return { published, skippedOutbound, rejectedClientState, failed };
};
