import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  auditLog,
  bindSupplierUser,
  caseStateTransitions,
  cases,
  createSupplier,
  getDefaultSupplier,
  getEscalationForSupplier,
  getSupplierByEmail,
  getSupplierForUser,
  insertEscalation,
  listOpenEscalationsForSupplier,
  makeDbClient,
  recordSupplierUpdate,
  tenants,
} from "../src/index.js";

// Exercises the real SQL behind the supplier portal data model: supplier
// identity + login binding, the per-case escalation record, the MINIMAL privacy
// projection (the supplier must never see customer PII), per-supplier row
// isolation, and the one-transaction `recordSupplierUpdate` (note + escalation
// resolve + case flip + audit). Gated on DATABASE_URL (skipped without a DB).
const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("supplier-store", () => {
  const client = makeDbClient({ databaseUrl: databaseUrl! });
  const { db } = client;
  const seededTenants: string[] = [];

  afterAll(async () => {
    if (seededTenants.length > 0) {
      // cases.tenant_id has no ON DELETE cascade, so delete cases first
      // (that cascades escalations + transitions); then the tenant delete
      // cascades suppliers + any remaining escalations.
      await db.delete(cases).where(inArray(cases.tenantId, seededTenants));
      await db.delete(tenants).where(inArray(tenants.id, seededTenants));
    }
    await client.close();
  });

  const seedTenant = async (): Promise<string> => {
    const id = randomUUID();
    await db.insert(tenants).values({
      id,
      name: "Supplier Test",
      workosOrganizationId: `org_${id.slice(0, 8)}`,
      settings: {},
    });
    seededTenants.push(id);
    return id;
  };

  const seedCase = async (
    tenantId: string,
    status: string,
  ): Promise<string> => {
    const id = randomUUID();
    await db.insert(cases).values({
      id,
      tenantId,
      channel: "email",
      status,
      currentAgentId: "missing-package-agent",
    });
    return id;
  };

  it("creates a supplier, resolves the default, finds by email (case-insensitive)", async () => {
    const tenantId = await seedTenant();
    const { id } = await createSupplier(db, tenantId, {
      name: "Acme Warehouse",
      email: "ops@acme-wh.com",
    });
    const def = await getDefaultSupplier(db, tenantId);
    expect(def?.id).toBe(id);
    expect(def?.email).toBe("ops@acme-wh.com");
    const byEmail = await getSupplierByEmail(db, tenantId, "OPS@acme-wh.com");
    expect(byEmail?.id).toBe(id);
  });

  it("binds a supplier login and resolves the supplier for that user (idempotent)", async () => {
    const tenantId = await seedTenant();
    const { id } = await createSupplier(db, tenantId, {
      name: "WH",
      email: "wh@x.com",
    });
    const user = randomUUID();
    expect(await getSupplierForUser(db, tenantId, user)).toBeNull();
    await bindSupplierUser(db, tenantId, "wh@x.com", user);
    expect((await getSupplierForUser(db, tenantId, user))?.id).toBe(id);
    await bindSupplierUser(db, tenantId, "wh@x.com", user); // idempotent
    expect((await getSupplierForUser(db, tenantId, user))?.id).toBe(id);
  });

  it("lists ONLY a supplier's own open escalations with the minimal privacy projection", async () => {
    const tenantId = await seedTenant();
    const supplierA = (
      await createSupplier(db, tenantId, { name: "A", email: "a@wh.com" })
    ).id;
    const supplierB = (
      await createSupplier(db, tenantId, { name: "B", email: "b@wh.com" })
    ).id;
    const caseId = await seedCase(tenantId, "waiting_for_supplier");

    await insertEscalation(db, {
      tenantId,
      caseId,
      supplierId: supplierA,
      problem: "Order stuck in transit 12 days",
      orderRef: "#1001",
      shipCity: "Berlin",
      shipCountry: "DE",
      trackingNumber: "TRK123",
    });

    const listA = await listOpenEscalationsForSupplier(db, supplierA);
    expect(listA).toHaveLength(1);
    const item = listA[0]!;
    // EXACT projected fields — no customer PII keys (email/address/thread) leak.
    expect(Object.keys(item).sort()).toEqual(
      [
        "caseId",
        "createdAt",
        "id",
        "orderRef",
        "problem",
        "shipCity",
        "shipCountry",
        "status",
        "trackingNumber",
      ].sort(),
    );
    expect(item.problem).toBe("Order stuck in transit 12 days");
    expect(item.orderRef).toBe("#1001");
    expect(item.status).toBe("open");

    // A different supplier in the same workspace sees nothing.
    expect(await listOpenEscalationsForSupplier(db, supplierB)).toHaveLength(0);
  });

  it("getEscalationForSupplier returns the minimal projection, scoped to the supplier", async () => {
    const tenantId = await seedTenant();
    const supplierA = (
      await createSupplier(db, tenantId, { name: "A", email: "a2@wh.com" })
    ).id;
    const supplierB = (
      await createSupplier(db, tenantId, { name: "B", email: "b2@wh.com" })
    ).id;
    const caseId = await seedCase(tenantId, "waiting_for_supplier");
    const { id: escId } = await insertEscalation(db, {
      tenantId,
      caseId,
      supplierId: supplierA,
      problem: "P",
      orderRef: "#2002",
      shipCity: null,
      shipCountry: null,
      trackingNumber: null,
    });
    const detail = await getEscalationForSupplier(db, supplierA, escId);
    expect(detail?.orderRef).toBe("#2002");
    expect(detail?.note).toBeNull();
    // Another supplier cannot read it (row-level scoping, not 403-via-app).
    expect(await getEscalationForSupplier(db, supplierB, escId)).toBeNull();
  });

  it("recordSupplierUpdate writes note + resolves the escalation + flips the case in ONE tx", async () => {
    const tenantId = await seedTenant();
    const supplierId = (
      await createSupplier(db, tenantId, { name: "A", email: "a3@wh.com" })
    ).id;
    const caseId = await seedCase(tenantId, "waiting_for_supplier");
    const { id: escId } = await insertEscalation(db, {
      tenantId,
      caseId,
      supplierId,
      problem: "P",
      orderRef: "#3003",
      shipCity: null,
      shipCountry: null,
      trackingNumber: null,
    });

    const res = await recordSupplierUpdate(db, {
      tenantId,
      supplierId,
      escalationId: escId,
      note: "Reshipped today, new tracking TRK999",
      proposedResolution: "reship",
      actorUuid: randomUUID(),
    });
    expect(res.kind).toBe("recorded");
    if (res.kind === "recorded") {
      expect(res.caseId).toBe(caseId);
      expect(res.resumed).toBe(true);
    }

    // Escalation resolved + note stored.
    const detail = await getEscalationForSupplier(db, supplierId, escId);
    expect(detail?.status).toBe("resolved");
    expect(detail?.note).toBe("Reshipped today, new tracking TRK999");

    // Case flipped waiting_for_supplier → in_progress + supplierUpdate stamped.
    const [row] = await db
      .select({ status: cases.status, context: cases.context })
      .from(cases)
      .where(eq(cases.id, caseId));
    expect(row?.status).toBe("in_progress");
    expect(
      (row?.context as Record<string, unknown>)["supplierUpdate"],
    ).toBeTruthy();

    // Audit row + state transition row written in the same tx.
    const audits = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(
        and(eq(auditLog.caseId, caseId), eq(auditLog.action, "supplier.updated")),
      );
    expect(audits).toHaveLength(1);
    const transitions = await db
      .select({ to: caseStateTransitions.toStatus })
      .from(caseStateTransitions)
      .where(eq(caseStateTransitions.caseId, caseId));
    expect(transitions.some((t) => t.to === "in_progress")).toBe(true);

    // Idempotent: a second submission on a resolved escalation is rejected.
    const again = await recordSupplierUpdate(db, {
      tenantId,
      supplierId,
      escalationId: escId,
      note: "x",
      proposedResolution: null,
      actorUuid: randomUUID(),
    });
    expect(again.kind).toBe("already_resolved");
  });

  it("recordSupplierUpdate is not_found for another supplier's escalation", async () => {
    const tenantId = await seedTenant();
    const supplierA = (
      await createSupplier(db, tenantId, { name: "A", email: "a4@wh.com" })
    ).id;
    const supplierB = (
      await createSupplier(db, tenantId, { name: "B", email: "b4@wh.com" })
    ).id;
    const caseId = await seedCase(tenantId, "waiting_for_supplier");
    const { id: escId } = await insertEscalation(db, {
      tenantId,
      caseId,
      supplierId: supplierA,
      problem: "P",
      orderRef: null,
      shipCity: null,
      shipCountry: null,
      trackingNumber: null,
    });
    const res = await recordSupplierUpdate(db, {
      tenantId,
      supplierId: supplierB,
      escalationId: escId,
      note: "n",
      proposedResolution: null,
      actorUuid: randomUUID(),
    });
    expect(res.kind).toBe("not_found");
  });
});
