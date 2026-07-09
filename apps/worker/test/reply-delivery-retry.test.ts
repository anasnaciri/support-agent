import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { TenantId } from "@support-agent/agent-core";
import type { DueReplyDelivery } from "@support-agent/db";
import {
  ConversationService,
  TicketAttachmentStore,
  TicketAttachmentStoreTest,
  TicketRepository,
  TicketRepositoryTest,
  makeConversationServiceTest,
  type TicketAttachmentRecord,
} from "@support-agent/services";
import {
  fireReplyDeliveryRetryOnce,
  reSendEffect,
  type ReplyDeliveryRetryDeps,
  type ReplySendOutcome,
} from "../src/reply-delivery-retry-schedule.js";

const due = (over: Partial<DueReplyDelivery> = {}): DueReplyDelivery => ({
  id: "rd-1",
  tenantId: "t1",
  ticketId: "c1",
  agentId: "order-status-agent",
  tool: "conversation.reply",
  mailbox: "support@shop.com",
  draftId: "d1",
  draft: { draftId: "d1", threadId: "th1", bodyText: "hi", to: [] },
  attempts: 1,
  maxAttempts: 6,
  ...over,
});

const makeDeps = (
  rows: ReadonlyArray<DueReplyDelivery>,
  sendImpl: (d: DueReplyDelivery) => ReplySendOutcome,
) => {
  const calls = {
    sent: [] as string[],
    resolved: [] as string[],
    failed: [] as Array<{ id: string; attempt: number }>,
    abandoned: [] as string[],
  };
  const deps: ReplyDeliveryRetryDeps = {
    listDue: () => Promise.resolve(rows),
    send: (d) => Promise.resolve(sendImpl(d)),
    markSent: (id) => {
      calls.sent.push(id);
      return Promise.resolve();
    },
    resolveTicket: (ticketId) => {
      calls.resolved.push(ticketId);
      return Promise.resolve();
    },
    recordFailure: (id, _err, attempt) => {
      calls.failed.push({ id, attempt });
      return Promise.resolve();
    },
    abandon: (id) => {
      calls.abandoned.push(id);
      return Promise.resolve();
    },
  };
  return { deps, calls };
};

// The stored draft is the ONLY record of what the failed reply was carrying.
// Re-sending it without the files delivers a message that refers to an
// attachment the customer never receives.
describe("reSendEffect — attachments", () => {
  const tenantId = TenantId("t1");

  /**
   * Seed a parked ticket (+ optionally one merchant upload on it), then
   * re-send its stored draft. `draftIds` receives the real row id so a test
   * can reference it, or ignore it to reference an id that doesn't exist.
   */
  const run = async (
    seedAttachment: boolean,
    draftIds: (attachmentId: string) => ReadonlyArray<string> | undefined,
  ) => {
    const convo = makeConversationServiceTest({});
    const layer = Layer.mergeAll(
      TicketRepositoryTest,
      convo.layer,
      TicketAttachmentStoreTest([]),
    );
    return Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* TicketRepository;
          const ticket = yield* repo.create({
            tenantId,
            channel: "email",
            currentAgentId: "order-status-agent" as never,
          });
          // The retry only fires while the ticket is parked on the failure.
          yield* repo.transitionStatus(ticket.id, "human_takeover");
          const store = yield* TicketAttachmentStore;
          const seeded: TicketAttachmentRecord | null = seedAttachment
            ? yield* store.record({
                tenantId,
                ticketId: ticket.id,
                source: "merchant",
                filename: "label.pdf",
                contentType: "application/pdf",
                sizeBytes: 3,
                storageKey: "upload/t1/c1/label.pdf",
                uploadedBy: "user_1",
              })
            : null;
          const ids = draftIds(seeded?.id ?? "never-created");
          const outcome = yield* reSendEffect({
            id: "rd-1",
            tenantId,
            ticketId: ticket.id,
            agentId: "order-status-agent",
            tool: "conversation.reply",
            mailbox: "support@shop.com",
            draftId: "d1",
            draft: {
              draftId: "d1",
              threadId: "th1",
              bodyText: "Label attached.",
              to: [{ name: "Jane", email: "jane@example.com" }],
              ...(ids ? { attachmentIds: ids } : {}),
            },
            attempts: 1,
            maxAttempts: 6,
          } as never);
          const after = yield* store.listForTicket(tenantId, ticket.id);
          return { outcome, after, sent: convo.handle.sent };
        }),
        layer,
      ),
    );
  };

  it("re-sends the draft's attachments, not an empty list", async () => {
    const out = await run(true, (id) => [id]);
    expect(out.outcome).toBe("sent");
    expect(out.sent).toHaveLength(1);
    expect(out.sent[0]!.input.attachments).toEqual([
      {
        filename: "label.pdf",
        contentType: "application/pdf",
        storageKey: "upload/t1/c1/label.pdf",
        sizeBytes: 3,
      },
    ]);
  });

  it("binds the re-sent files to the message that finally carried them", async () => {
    const out = await run(true, (id) => [id]);
    expect(out.after[0]?.messageId).toBe(out.sent[0]!.result.id);
    expect(out.after[0]?.usedAt).toBeInstanceOf(Date);
  });

  it("refuses to deliver when a promised attachment no longer resolves", async () => {
    // Better a retryable failure than a reply whose file silently vanished.
    const out = await run(false, () => ["gone"]);
    expect(out.outcome).toEqual({ error: "attachment_not_found" });
    expect(out.sent).toHaveLength(0);
  });

  it("sends a plain draft (no attachmentIds) unchanged", async () => {
    const out = await run(false, () => undefined);
    expect(out.outcome).toBe("sent");
    expect(out.sent[0]!.input.attachments).toEqual([]);
  });
});

describe("fireReplyDeliveryRetryOnce", () => {
  it("on a successful re-send: marks sent + auto-resolves the ticket", async () => {
    const { deps, calls } = makeDeps([due()], () => "sent");
    const out = await fireReplyDeliveryRetryOnce(deps);
    expect(out).toEqual({ sent: 1, failed: 0, abandoned: 0, skipped: 0 });
    expect(calls.sent).toEqual(["rd-1"]);
    expect(calls.resolved).toEqual(["c1"]);
    expect(calls.failed).toHaveLength(0);
    expect(calls.abandoned).toHaveLength(0);
  });

  it("on a failure under the cap: records the failure with the next attempt number", async () => {
    const { deps, calls } = makeDeps([due({ attempts: 2 })], () => ({
      error: "ConversationSendFailed",
    }));
    const out = await fireReplyDeliveryRetryOnce(deps);
    expect(out.failed).toBe(1);
    expect(out.abandoned).toBe(0);
    expect(calls.failed).toEqual([{ id: "rd-1", attempt: 3 }]);
    expect(calls.resolved).toHaveLength(0);
    expect(calls.sent).toHaveLength(0);
  });

  it("on a failure at the cap (attempts+1 >= maxAttempts): abandons the row", async () => {
    const { deps, calls } = makeDeps(
      [due({ attempts: 5, maxAttempts: 6 })],
      () => ({ error: "still failing" }),
    );
    const out = await fireReplyDeliveryRetryOnce(deps);
    expect(out.abandoned).toBe(1);
    expect(out.failed).toBe(0);
    expect(calls.abandoned).toEqual(["rd-1"]);
    expect(calls.failed).toHaveLength(0);
  });

  it("skips re-sending when the ticket moved on (human handled it): marks sent, no resolve", async () => {
    const { deps, calls } = makeDeps([due()], () => "skip");
    const out = await fireReplyDeliveryRetryOnce(deps);
    expect(out.skipped).toBe(1);
    expect(calls.sent).toEqual(["rd-1"]);
    expect(calls.resolved).toHaveLength(0);
    expect(calls.failed).toHaveLength(0);
    expect(calls.abandoned).toHaveLength(0);
  });

  it("processes a mixed batch independently", async () => {
    const rows = [
      due({ id: "ok", ticketId: "cok" }),
      due({ id: "retry", ticketId: "cr", attempts: 1 }),
      due({ id: "cap", ticketId: "cc", attempts: 5 }),
    ];
    const { deps, calls } = makeDeps(rows, (d) =>
      d.id === "ok" ? "sent" : { error: "boom" },
    );
    const out = await fireReplyDeliveryRetryOnce(deps);
    expect(out).toEqual({ sent: 1, failed: 1, abandoned: 1, skipped: 0 });
    expect(calls.sent).toEqual(["ok"]);
    expect(calls.resolved).toEqual(["cok"]);
    expect(calls.failed).toEqual([{ id: "retry", attempt: 2 }]);
    expect(calls.abandoned).toEqual(["cap"]);
  });
});
