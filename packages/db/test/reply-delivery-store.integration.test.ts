import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  abandonReplyDelivery,
  tickets,
  enqueueReplyDelivery,
  getActiveReplyDeliveryForTicket,
  listDueReplyDeliveries,
  makeDbClient,
  markReplyDeliverySent,
  recordReplyDeliveryFailure,
  replyDeliveries,
  requeueReplyDeliveryNow,
  tenants,
} from "../src/index.js";

// Exercises the real SQL behind the customer-reply DELIVERY outbox: enqueue +
// the per-draft dedupe (a re-run of the same failed send bumps the existing
// pending row instead of duplicating), the due-sweep query (status + schedule
// gating), the sent / failure / abandon transitions, the per-ticket lookup the
// dashboard reads, and the manual requeue ("Retry sending email"). Gated on
// DATABASE_URL (skipped without a DB).
const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("reply-delivery-store", () => {
  const client = makeDbClient({ databaseUrl: databaseUrl! });
  const { db } = client;
  const seededTenants: string[] = [];

  afterAll(async () => {
    if (seededTenants.length > 0) {
      // tickets.tenant_id has no ON DELETE cascade, so delete tickets first (that
      // cascades reply_deliveries); then the tenant delete cascades the rest.
      await db.delete(tickets).where(inArray(tickets.tenantId, seededTenants));
      await db.delete(tenants).where(inArray(tenants.id, seededTenants));
    }
    await client.close();
  });

  const seedTenant = async (): Promise<string> => {
    const id = randomUUID();
    await db.insert(tenants).values({
      id,
      name: "Reply Delivery Test",
      workosOrganizationId: `org_${id.slice(0, 8)}`,
      settings: {},
    });
    seededTenants.push(id);
    return id;
  };

  const seedTicket = async (tenantId: string, status: string): Promise<string> => {
    const id = randomUUID();
    await db.insert(tickets).values({
      id,
      tenantId,
      channel: "email",
      status,
      currentAgentId: "order-status-agent",
    });
    return id;
  };

  const draftOf = (draftId: string) => ({
    threadId: "thread-1",
    to: [{ name: null, email: "customer@example.com" }],
    subject: "Re: order",
    bodyText: "Your order is on the way.",
    bodyHtml: null,
    inReplyToMessageId: null,
    draftId,
  });

  it("enqueues a failed delivery (attempts=1) and reads it back for the ticket", async () => {
    const tenantId = await seedTenant();
    const ticketId = await seedTicket(tenantId, "human_takeover");
    const { id } = await enqueueReplyDelivery(db, {
      tenantId,
      ticketId,
      agentId: "order-status-agent",
      tool: "conversation.reply",
      mailbox: "support@shop.com",
      draftId: "draft-1",
      draft: draftOf("draft-1"),
      error: "ConversationSendFailed",
      nextAttemptAt: new Date(Date.now() + 60_000),
    });
    expect(id).toBeTruthy();

    const active = await getActiveReplyDeliveryForTicket(db, ticketId);
    expect(active).not.toBeNull();
    expect(active!.status).toBe("pending");
    expect(active!.attempts).toBe(1);
    expect(active!.tool).toBe("conversation.reply");
    expect(active!.mailbox).toBe("support@shop.com");
    expect(active!.lastError).toBe("ConversationSendFailed");
    // Draft is replayed verbatim on retry — round-trips through jsonb intact.
    expect((active!.draft as { draftId: string }).draftId).toBe("draft-1");
  });

  it("dedupes a re-run of the SAME failed draft (bumps attempts, one row)", async () => {
    const tenantId = await seedTenant();
    const ticketId = await seedTicket(tenantId, "human_takeover");
    const first = await enqueueReplyDelivery(db, {
      tenantId,
      ticketId,
      agentId: "a",
      tool: "conversation.reply",
      mailbox: null,
      draftId: "dup",
      draft: draftOf("dup"),
      error: "err-1",
      nextAttemptAt: new Date(Date.now() + 60_000),
    });
    const second = await enqueueReplyDelivery(db, {
      tenantId,
      ticketId,
      agentId: "a",
      tool: "conversation.reply",
      mailbox: null,
      draftId: "dup",
      draft: draftOf("dup"),
      error: "err-2",
      nextAttemptAt: new Date(Date.now() + 120_000),
    });
    expect(second.id).toBe(first.id);
    const rows = await db
      .select()
      .from(replyDeliveries)
      .where(eq(replyDeliveries.ticketId, ticketId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attempts).toBe(2);
    expect(rows[0]!.lastError).toBe("err-2");
  });

  it("listDue returns only pending rows whose next_attempt_at is due", async () => {
    const tenantId = await seedTenant();
    const dueTicket = await seedTicket(tenantId, "human_takeover");
    const futureTicket = await seedTicket(tenantId, "human_takeover");
    const due = await enqueueReplyDelivery(db, {
      tenantId,
      ticketId: dueTicket,
      agentId: "a",
      tool: "conversation.reply",
      mailbox: null,
      draftId: "due",
      draft: draftOf("due"),
      error: "e",
      nextAttemptAt: new Date(Date.now() - 1_000), // already due
    });
    await enqueueReplyDelivery(db, {
      tenantId,
      ticketId: futureTicket,
      agentId: "a",
      tool: "conversation.reply",
      mailbox: null,
      draftId: "future",
      draft: draftOf("future"),
      error: "e",
      nextAttemptAt: new Date(Date.now() + 3_600_000), // not yet due
    });
    const dueRows = await listDueReplyDeliveries(db, new Date(), 50);
    const ids = dueRows.map((r) => r.id);
    expect(ids).toContain(due.id);
    expect(dueRows.find((r) => r.id === due.id)?.ticketId).toBe(dueTicket);
    expect(dueRows.some((r) => r.ticketId === futureTicket)).toBe(false);
  });

  it("markSent flips status to sent and drops it from the due sweep + active lookup", async () => {
    const tenantId = await seedTenant();
    const ticketId = await seedTicket(tenantId, "human_takeover");
    const { id } = await enqueueReplyDelivery(db, {
      tenantId,
      ticketId,
      agentId: "a",
      tool: "conversation.reply",
      mailbox: null,
      draftId: "sent",
      draft: draftOf("sent"),
      error: "e",
      nextAttemptAt: new Date(Date.now() - 1_000),
    });
    await markReplyDeliverySent(db, id);
    const dueRows = await listDueReplyDeliveries(db, new Date(), 50);
    expect(dueRows.some((r) => r.id === id)).toBe(false);
    expect(await getActiveReplyDeliveryForTicket(db, ticketId)).toBeNull();
    const row = (
      await db.select().from(replyDeliveries).where(eq(replyDeliveries.id, id))
    )[0]!;
    expect(row.status).toBe("sent");
    expect(row.sentAt).not.toBeNull();
  });

  it("recordFailure bumps attempts + reschedules; abandon parks the row", async () => {
    const tenantId = await seedTenant();
    const ticketId = await seedTicket(tenantId, "human_takeover");
    const { id } = await enqueueReplyDelivery(db, {
      tenantId,
      ticketId,
      agentId: "a",
      tool: "conversation.reply",
      mailbox: null,
      draftId: "retry",
      draft: draftOf("retry"),
      error: "e1",
      nextAttemptAt: new Date(Date.now() - 1_000),
    });
    const future = new Date(Date.now() + 120_000);
    await recordReplyDeliveryFailure(db, id, "e2", future);
    let row = (
      await db.select().from(replyDeliveries).where(eq(replyDeliveries.id, id))
    )[0]!;
    expect(row.attempts).toBe(2);
    expect(row.lastError).toBe("e2");
    expect(row.status).toBe("pending");

    await abandonReplyDelivery(db, id, "gave up");
    row = (
      await db.select().from(replyDeliveries).where(eq(replyDeliveries.id, id))
    )[0]!;
    expect(row.status).toBe("abandoned");
    expect(row.lastError).toBe("gave up");
    // An abandoned row is no longer swept, but still surfaces for the ticket
    // (so the dashboard can show "delivery failed" + the Retry button).
    const dueAfterAbandon = await listDueReplyDeliveries(db, new Date(), 50);
    expect(dueAfterAbandon.some((r) => r.id === id)).toBe(false);
    expect((await getActiveReplyDeliveryForTicket(db, ticketId))?.status).toBe(
      "abandoned",
    );
  });

  it("requeueNow revives an abandoned delivery for the ticket (manual retry)", async () => {
    const tenantId = await seedTenant();
    const ticketId = await seedTicket(tenantId, "human_takeover");
    const { id } = await enqueueReplyDelivery(db, {
      tenantId,
      ticketId,
      agentId: "a",
      tool: "conversation.reply",
      mailbox: null,
      draftId: "manual",
      draft: draftOf("manual"),
      error: "e",
      nextAttemptAt: new Date(Date.now() + 3_600_000),
    });
    await abandonReplyDelivery(db, id, "cap");

    const requeued = await requeueReplyDeliveryNow(db, ticketId);
    expect(requeued?.id).toBe(id);
    const row = (
      await db.select().from(replyDeliveries).where(eq(replyDeliveries.id, id))
    )[0]!;
    expect(row.status).toBe("pending");
    expect(row.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
    // It's now picked up by the sweep again.
    const dueRows = await listDueReplyDeliveries(db, new Date(), 50);
    expect(dueRows.some((r) => r.id === id)).toBe(true);
  });

  it("requeueNow returns null when the ticket has no failed delivery", async () => {
    const tenantId = await seedTenant();
    const ticketId = await seedTicket(tenantId, "in_progress");
    expect(await requeueReplyDeliveryNow(db, ticketId)).toBeNull();
  });
});
