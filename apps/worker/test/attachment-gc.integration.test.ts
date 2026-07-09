import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { BlobStorageFailed, type ApprovalRiskLevel } from "@support-agent/agent-core";
import { BlobStorage, BlobStorageTest } from "@support-agent/services";
import {
  DbClient,
  DbClientLive,
  approvals,
  createSupplier,
  insertEscalation,
  makeDbClient,
  suppliers,
  ticketAttachments,
  ticketSupplierEscalations,
  tickets,
  tenants,
} from "@support-agent/db";
import {
  ORPHAN_UPLOAD_AFTER_DAYS,
  computeOrphanUploadCutoff,
  findOrphanAttachments,
  gcTenantAttachments,
} from "../src/attachment-gc.js";

// Orphaned-upload GC against real Postgres. The predicate is the whole design,
// so each retain/reclaim rule gets its own assertion:
//   - unused + old + nothing pending → reclaimed (blob AND row)
//   - used (sent on a reply / bound into a supplier update) → retained forever
//   - unused but young → retained
//   - inbound (customer) attachment → never swept
//   - unused but the ticket has a PENDING approval → retained (draft may hold it)
//   - unused but its escalation is still OPEN → retained (supplier may still post)
//   - another tenant's orphan → never touched

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

const DAY_MS = 24 * 60 * 60 * 1000;

describeIfDb("attachment GC (Live, integration)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const now = new Date("2026-07-09T03:00:00.000Z");
  const old = new Date(now.getTime() - (ORPHAN_UPLOAD_AFTER_DAYS + 1) * DAY_MS);
  const recent = new Date(now.getTime() - 2 * DAY_MS);

  // Blobs live in the in-memory BlobStorage; the test seeds one object per
  // attachment so a reclaim is observable as "key gone from the store".
  const blobs = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const blobLayer = Layer.effect(
    BlobStorage,
    Effect.sync(() =>
      BlobStorage.of({
        put: (input) =>
          Effect.sync(() => {
            blobs.set(input.key, {
              bytes: input.bytes,
              contentType: input.contentType,
            });
          }),
        get: () => Effect.die("unused"),
        presignGetUrl: () => Effect.die("unused"),
        delete: (key) =>
          Effect.sync(() => {
            blobs.delete(key);
          }),
      }),
    ),
  );

  const dbLayer = DbClientLive({ databaseUrl: databaseUrl! });
  const gcLayer = Layer.mergeAll(dbLayer, blobLayer);
  const runLive = <A, E>(eff: Effect.Effect<A, E, DbClient | BlobStorage>) =>
    Effect.runPromise(Effect.provide(eff, gcLayer).pipe(Effect.scoped));

  let supplierId = "";
  const ticketIds: string[] = [];

  const seedTicket = async (tenantId: string): Promise<string> => {
    if (!raw) throw new Error("no raw client");
    const id = randomUUID();
    await raw.db.insert(tickets).values({
      id,
      tenantId,
      channel: "email",
      currentAgentId: "support-triage",
      status: "in_progress",
      priority: "normal",
    });
    ticketIds.push(id);
    return id;
  };

  const seedAttachment = async (params: {
    readonly tenantId: string;
    readonly ticketId: string;
    readonly source: "inbound" | "merchant" | "supplier";
    readonly createdAt: Date;
    readonly usedAt?: Date | null;
    readonly escalationId?: string | null;
  }): Promise<{ id: string; storageKey: string }> => {
    if (!raw) throw new Error("no raw client");
    const id = randomUUID();
    const storageKey = `upload/${params.tenantId}/${params.ticketId}/${id}.png`;
    await raw.db.insert(ticketAttachments).values({
      id,
      tenantId: params.tenantId,
      ticketId: params.ticketId,
      source: params.source,
      filename: `${id}.png`,
      contentType: "image/png",
      sizeBytes: 3,
      storageKey,
      createdAt: params.createdAt,
      usedAt: params.usedAt ?? null,
      escalationId: params.escalationId ?? null,
    });
    blobs.set(storageKey, { bytes: new Uint8Array([1]), contentType: "image/png" });
    return { id, storageKey };
  };

  const seedPendingApproval = async (
    tenantId: string,
    ticketId: string,
  ): Promise<void> => {
    if (!raw) throw new Error("no raw client");
    await raw.db.insert(approvals).values({
      id: randomUUID(),
      tenantId,
      ticketId,
      agentId: "support-triage",
      tool: "conversation.reply",
      proposedInput: {},
      reasoning: "",
      riskLevel: "medium" satisfies ApprovalRiskLevel,
      status: "pending",
      expiresAt: new Date(now.getTime() + 30 * DAY_MS),
    });
  };

  beforeAll(async () => {
    if (!raw) return;
    await raw.db.insert(tenants).values([
      { id: tenantA, name: "attachment-gc-A", settings: {} },
      { id: tenantB, name: "attachment-gc-B", settings: {} },
    ]);
    const supplier = await createSupplier(raw.db, tenantA, {
      name: "GC Warehouse",
      email: `gc-${randomUUID().slice(0, 8)}@example.com`,
    });
    supplierId = supplier.id;
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.db
      .delete(approvals)
      .where(sql`${approvals.tenantId} IN (${tenantA}, ${tenantB})`);
    await raw.db
      .delete(ticketAttachments)
      .where(sql`${ticketAttachments.tenantId} IN (${tenantA}, ${tenantB})`);
    await raw.db
      .delete(ticketSupplierEscalations)
      .where(sql`${ticketSupplierEscalations.tenantId} IN (${tenantA}, ${tenantB})`);
    await raw.db
      .delete(tickets)
      .where(sql`${tickets.tenantId} IN (${tenantA}, ${tenantB})`);
    await raw.db.delete(suppliers).where(eq(suppliers.tenantId, tenantA));
    await raw.db
      .delete(tenants)
      .where(sql`${tenants.id} IN (${tenantA}, ${tenantB})`);
    await raw.close();
  });

  it("computes the cutoff at 30 days before now", () => {
    expect(computeOrphanUploadCutoff(now).toISOString()).toBe(
      new Date(now.getTime() - 30 * DAY_MS).toISOString(),
    );
  });

  it("reclaims an aged, never-used upload — blob first, then the index row", async () => {
    if (!raw) return;
    const ticketId = await seedTicket(tenantA);
    const orphan = await seedAttachment({
      tenantId: tenantA,
      ticketId,
      source: "merchant",
      createdAt: old,
    });

    const result = await runLive(gcTenantAttachments(tenantA, now));
    expect(result.reclaimed).toBe(1);
    expect(result.failed).toBe(0);
    expect(blobs.has(orphan.storageKey)).toBe(false);
    const rows = await raw.db
      .select({ id: ticketAttachments.id })
      .from(ticketAttachments)
      .where(eq(ticketAttachments.id, orphan.id));
    expect(rows).toHaveLength(0);
  });

  it("never reclaims a file that was actually sent (used_at set)", async () => {
    if (!raw) return;
    const ticketId = await seedTicket(tenantA);
    const sent = await seedAttachment({
      tenantId: tenantA,
      ticketId,
      source: "merchant",
      createdAt: old,
      usedAt: old,
    });

    const orphans = await runLive(
      findOrphanAttachments(tenantA, computeOrphanUploadCutoff(now)),
    );
    expect(orphans.map((o) => o.id)).not.toContain(sent.id);
    await runLive(gcTenantAttachments(tenantA, now));
    expect(blobs.has(sent.storageKey)).toBe(true);
  });

  it("keeps a young upload — the merchant may still be composing", async () => {
    if (!raw) return;
    const ticketId = await seedTicket(tenantA);
    const young = await seedAttachment({
      tenantId: tenantA,
      ticketId,
      source: "merchant",
      createdAt: recent,
    });
    await runLive(gcTenantAttachments(tenantA, now));
    expect(blobs.has(young.storageKey)).toBe(true);
  });

  it("never sweeps an inbound customer attachment", async () => {
    if (!raw) return;
    const ticketId = await seedTicket(tenantA);
    const inbound = await seedAttachment({
      tenantId: tenantA,
      ticketId,
      source: "inbound",
      createdAt: old,
    });
    await runLive(gcTenantAttachments(tenantA, now));
    expect(blobs.has(inbound.storageKey)).toBe(true);
  });

  it("retains an aged upload while the ticket has a PENDING approval", async () => {
    if (!raw) return;
    const ticketId = await seedTicket(tenantA);
    const staged = await seedAttachment({
      tenantId: tenantA,
      ticketId,
      source: "merchant",
      createdAt: old,
    });
    await seedPendingApproval(tenantA, ticketId);

    await runLive(gcTenantAttachments(tenantA, now));
    expect(blobs.has(staged.storageKey)).toBe(true);

    // Once the approval is decided, the same file is reclaimable.
    await raw.db
      .update(approvals)
      .set({ status: "rejected" })
      .where(eq(approvals.ticketId, ticketId));
    const after = await runLive(gcTenantAttachments(tenantA, now));
    expect(after.reclaimed).toBe(1);
    expect(blobs.has(staged.storageKey)).toBe(false);
  });

  it("retains a supplier upload while its escalation is still OPEN", async () => {
    if (!raw) return;
    const ticketId = await seedTicket(tenantA);
    const { id: escalationId } = await insertEscalation(raw.db, {
      tenantId: tenantA,
      ticketId,
      supplierId,
      problem: "where is it",
      orderRef: null,
      shipCity: null,
      shipCountry: null,
      trackingNumber: null,
    });
    const staged = await seedAttachment({
      tenantId: tenantA,
      ticketId,
      source: "supplier",
      createdAt: old,
      escalationId,
    });

    await runLive(gcTenantAttachments(tenantA, now));
    expect(blobs.has(staged.storageKey)).toBe(true);

    // Resolved escalation + never bound into the update → abandoned upload.
    await raw.db
      .update(ticketSupplierEscalations)
      .set({ status: "resolved", resolvedAt: now })
      .where(eq(ticketSupplierEscalations.id, escalationId));
    const after = await runLive(gcTenantAttachments(tenantA, now));
    expect(after.reclaimed).toBe(1);
    expect(blobs.has(staged.storageKey)).toBe(false);
  });

  it("never touches another tenant's orphan", async () => {
    if (!raw) return;
    const ticketB = await seedTicket(tenantB);
    const theirs = await seedAttachment({
      tenantId: tenantB,
      ticketId: ticketB,
      source: "merchant",
      createdAt: old,
    });
    await runLive(gcTenantAttachments(tenantA, now));
    expect(blobs.has(theirs.storageKey)).toBe(true);
  });

  it("keeps the index row when the blob delete fails, so the next pass retries", async () => {
    if (!raw) return;
    const ticketId = await seedTicket(tenantA);
    const orphan = await seedAttachment({
      tenantId: tenantA,
      ticketId,
      source: "merchant",
      createdAt: old,
    });

    const failing = BlobStorageTest({
      delete: (key) => Effect.fail(new BlobStorageFailed({ key, cause: "down" })),
    });
    const result = await Effect.runPromise(
      Effect.provide(
        gcTenantAttachments(tenantA, now),
        Layer.mergeAll(dbLayer, failing),
      ).pipe(Effect.scoped),
    );
    expect(result.reclaimed).toBe(0);
    expect(result.failed).toBe(1);
    const rows = await raw.db
      .select({ id: ticketAttachments.id })
      .from(ticketAttachments)
      .where(eq(ticketAttachments.id, orphan.id));
    expect(rows).toHaveLength(1);
  });
});
