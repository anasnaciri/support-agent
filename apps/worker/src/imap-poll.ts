// ============================================================
// IMAP inbound poll cron
// ============================================================
//
// IMAP has no webhook — to notice new customer mail we poll each active
// generic mailbox on a short interval. For each connector we fetch messages
// with UID greater than the stored `lastUid` cursor, publish a
// `message.received` for inbound ones, and advance the cursor. The very first
// run seeds the cursor at the current highest UID so we don't replay the whole
// mailbox.
//
// Scheduled in `apps/worker/src/index.ts` via `boss.schedule("imap.poll", …)`.

import { Effect } from "effect";
import { and, eq } from "drizzle-orm";
import {
  ConnectorCredentialStore,
  namespaceThreadId,
  type ConnectorConnection,
} from "@support-agent/services";
import { TenantId, type DomainEvent } from "@support-agent/agent-core";
import {
  imapConfigFromConnection,
  makeImapSmtpOps,
  toConversationMessage,
  toInboundMessage,
  type ImapSmtpConfig,
  type ImapSmtpOps,
} from "@support-agent/providers";
import {
  DbClient,
  connectorConnections,
  type ConnectorConnectionRow,
} from "@support-agent/db";

export interface PollActiveImapDeps {
  /** Publish a domain event onto the workflow queue. */
  readonly publish: (event: DomainEvent) => Promise<void>;
  /** Override the ops factory for tests. Defaults to live `makeImapSmtpOps`. */
  readonly opsFactory?: (config: ImapSmtpConfig) => ImapSmtpOps;
}

export interface ImapPollResult {
  readonly tenantId: string;
  readonly mailbox: string;
  readonly outcome:
    | "seeded"
    | "skipped_no_config"
    | { readonly polled: number }
    | { readonly failed: string };
}

/** Narrow store surface `pollOne` needs (tests pass a plain object). */
export interface ImapPollStoreOps {
  readonly patchMetadata: (input: {
    tenantId: string;
    shopDomain: string;
    metadata: Readonly<Record<string, unknown>>;
  }) => Promise<void>;
}

export const pollOne = async (
  conn: ConnectorConnection,
  deps: PollActiveImapDeps,
  store: ImapPollStoreOps,
): Promise<ImapPollResult> => {
  const config = imapConfigFromConnection(conn);
  if (!config) {
    return {
      tenantId: conn.tenantId,
      mailbox: conn.shopDomain,
      outcome: "skipped_no_config",
    };
  }
  const ops = (deps.opsFactory ?? makeImapSmtpOps)(config);
  const lastUidRaw = conn.metadata["lastUid"];

  try {
    // First run: seed the cursor at the current top of the mailbox so we
    // start from "new mail after connect", not the entire history.
    if (typeof lastUidRaw !== "number") {
      const latest = await ops.latestUid();
      await store.patchMetadata({
        tenantId: conn.tenantId,
        shopDomain: conn.shopDomain,
        metadata: { lastUid: latest },
      });
      return { tenantId: conn.tenantId, mailbox: conn.shopDomain, outcome: "seeded" };
    }

    const { messages, latestUid } = await ops.listSince(lastUidRaw);
    let polled = 0;
    const acceptedInboundUids: Array<number> = [];
    for (const raw of messages) {
      const msg = toConversationMessage(raw, conn.shopDomain);
      if (msg.direction === "outbound") continue; // mail we sent
      // Namespace the thread id so the conversation router replies through
      // this same connector (a tenant can hold several mailboxes at once).
      const inbound = {
        ...toInboundMessage(msg),
        threadId: namespaceThreadId("imap", msg.threadId),
        mailbox: conn.shopDomain,
        // RFC threading headers — the runtime correlates this reply to its
        // existing ticket by matching these against the message-id index, which
        // is robust to clients that reorder/drop `References` (the failure
        // that otherwise minted a duplicate ticket per reply).
        inReplyTo: raw.inReplyTo,
        references: raw.references,
      };
      await deps.publish({
        type: "message.received",
        tenantId: TenantId(conn.tenantId),
        threadId: inbound.threadId,
        payload: inbound,
      });
      acceptedInboundUids.push(raw.uid);
      polled += 1;
    }
    if (acceptedInboundUids.length > 0) {
      await ops.markRead(acceptedInboundUids).catch((cause) => {
        console.warn(
          `[imap-poll] failed to mark messages read for ${conn.shopDomain}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        );
      });
    }
    if (latestUid > lastUidRaw) {
      await store.patchMetadata({
        tenantId: conn.tenantId,
        shopDomain: conn.shopDomain,
        metadata: { lastUid: latestUid },
      });
    }
    return { tenantId: conn.tenantId, mailbox: conn.shopDomain, outcome: { polled } };
  } catch (cause) {
    return {
      tenantId: conn.tenantId,
      mailbox: conn.shopDomain,
      outcome: { failed: cause instanceof Error ? cause.message : String(cause) },
    };
  }
};

/** One poll pass over every active IMAP/SMTP connector. */
export const pollActiveImapMailboxes = (
  deps: PollActiveImapDeps,
): Effect.Effect<
  ReadonlyArray<ImapPollResult>,
  unknown,
  DbClient | ConnectorCredentialStore
> =>
  Effect.gen(function* () {
    const db = yield* DbClient;
    const store = yield* ConnectorCredentialStore;

    const rows: ReadonlyArray<ConnectorConnectionRow> = yield* Effect.tryPromise({
      try: () =>
        db
          .select()
          .from(connectorConnections)
          .where(
            and(
              eq(connectorConnections.provider, "imap"),
              eq(connectorConnections.status, "active"),
            ),
          ),
      catch: (cause) => new Error(`imap-poll select: ${String(cause)}`),
    });

    const storeOps: ImapPollStoreOps = {
      patchMetadata: (input) =>
        Effect.runPromise(
          store
            .patchMetadata({
              tenantId: TenantId(input.tenantId),
              provider: "imap",
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

    const results: Array<ImapPollResult> = [];
    for (const row of rows) {
      const conn = yield* store
        .get(TenantId(row.tenantId), "imap", row.shopDomain)
        .pipe(
          Effect.either,
          Effect.map((either) =>
            either._tag === "Right" ? either.right : null,
          ),
        );
      if (!conn) continue;
      const result = yield* Effect.tryPromise({
        try: () => pollOne(conn, deps, storeOps),
        catch: (cause): ImapPollResult => ({
          tenantId: row.tenantId,
          mailbox: row.shopDomain,
          outcome: { failed: cause instanceof Error ? cause.message : String(cause) },
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
              } as ImapPollResult),
        ),
      );
      results.push(result);
    }
    return results;
  });
