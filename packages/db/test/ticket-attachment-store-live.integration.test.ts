import { afterAll, describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { TicketId, TenantId } from "@support-agent/agent-core";
import { TicketAttachmentStore } from "@support-agent/services";
import {
  tickets,
  DbClientLive,
  makeDbClient,
  tenants,
  ticketAttachments,
  TicketAttachmentStoreLive,
} from "../src/index.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("TicketAttachmentStoreLive", () => {
  const client = makeDbClient({ databaseUrl: databaseUrl! });
  const { db } = client;

  afterAll(async () => {
    await client.close();
  });

  const layer = TicketAttachmentStoreLive.pipe(
    Layer.provide(DbClientLive({ databaseUrl: databaseUrl! })),
  );

  it("records rows and resolves ids only within the owning tenant + ticket", async () => {
    const tenantId = randomUUID();
    const otherTenantId = randomUUID();
    const ticketA = randomUUID();
    const ticketB = randomUUID();
    const foreignTicket = randomUUID();
    await db.insert(tenants).values([
      { id: tenantId, name: "Attachment Test" },
      { id: otherTenantId, name: "Attachment Test Other" },
    ]);
    await db.insert(tickets).values([
      {
        id: ticketA,
        tenantId,
        channel: "email",
        status: "new",
        currentAgentId: "triage-agent",
      },
      {
        id: ticketB,
        tenantId,
        channel: "email",
        status: "new",
        currentAgentId: "triage-agent",
      },
      {
        id: foreignTicket,
        tenantId: otherTenantId,
        channel: "email",
        status: "new",
        currentAgentId: "triage-agent",
      },
    ]);

    try {
      const result = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const store = yield* TicketAttachmentStore;
            const supplierPhoto = yield* store.record({
              tenantId: TenantId(tenantId),
              ticketId: TicketId(ticketA),
              source: "supplier",
              filename: "replacement-label.pdf",
              contentType: "application/pdf",
              sizeBytes: 1234,
              storageKey: `upload/${tenantId}/${ticketA}/label.pdf`,
              uploadedBy: "supplier-user-1",
            });
            const merchantPhoto = yield* store.record({
              tenantId: TenantId(tenantId),
              ticketId: TicketId(ticketA),
              source: "merchant",
              filename: "photo.png",
              contentType: "image/png",
              sizeBytes: 42,
              storageKey: `upload/${tenantId}/${ticketA}/photo.png`,
            });
            const crossTicket = yield* store.record({
              tenantId: TenantId(otherTenantId),
              ticketId: TicketId(foreignTicket),
              source: "merchant",
              filename: "foreign.png",
              contentType: "image/png",
              sizeBytes: 9,
              storageKey: `upload/${otherTenantId}/${foreignTicket}/x.png`,
            });
            // Resolution: order follows the ids argument; the foreign row and
            // an unknown id silently drop out; ticketB sees nothing.
            const resolved = yield* store.getByIds(
              TenantId(tenantId),
              TicketId(ticketA),
              [merchantPhoto.id, crossTicket.id, randomUUID(), supplierPhoto.id],
            );
            const wrongTicket = yield* store.getByIds(
              TenantId(tenantId),
              TicketId(ticketB),
              [supplierPhoto.id],
            );
            const listed = yield* store.listForTicket(
              TenantId(tenantId),
              TicketId(ticketA),
            );
            return { supplierPhoto, resolved, wrongTicket, listed };
          }),
          layer,
        ),
      );

      expect(result.supplierPhoto.uploadedBy).toBe("supplier-user-1");
      expect(result.supplierPhoto.createdAt).toBeInstanceOf(Date);
      expect(result.resolved.map((r) => r.filename)).toEqual([
        "photo.png",
        "replacement-label.pdf",
      ]);
      expect(result.wrongTicket).toHaveLength(0);
      expect(result.listed).toHaveLength(2);
      expect(result.listed.map((r) => r.source).sort()).toEqual([
        "merchant",
        "supplier",
      ]);
    } finally {
      await db
        .delete(ticketAttachments)
        .where(eq(ticketAttachments.tenantId, tenantId));
      await db
        .delete(ticketAttachments)
        .where(eq(ticketAttachments.tenantId, otherTenantId));
      await db.delete(tickets).where(eq(tickets.tenantId, tenantId));
      await db.delete(tickets).where(eq(tickets.tenantId, otherTenantId));
      await db.delete(tenants).where(eq(tenants.id, tenantId));
      await db.delete(tenants).where(eq(tenants.id, otherTenantId));
    }
  });
});
