import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  auditLog,
  bindSupplierUser,
  bindSupplierUserAllTenants,
  caseStateTransitions,
  caseSupplierEscalations,
  cases,
  createInvitation,
  createSupplier,
  ensureSupplierRole,
  getDefaultSupplier,
  listRoles,
  getEscalationForSupplier,
  getSupplierByEmail,
  getSupplierForUser,
  hasOpenEscalationForCase,
  insertEscalation,
  listOpenEscalationsForSupplier,
  listSupplierWorkspacesForUser,
  listTenantsWithPendingSupplierInvitationForEmail,
  listUnsentSupplierEscalations,
  makeDbClient,
  recordSupplierUpdate,
  suppliers,
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

  it("binds the SAME user across MULTIPLE tenants (one supplier ↔ many merchants)", async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const email = "multi@wh.com";
    const a = (await createSupplier(db, tenantA, { name: "A", email })).id;
    const b = (await createSupplier(db, tenantB, { name: "B", email })).id;
    const user = randomUUID();

    await bindSupplierUserAllTenants(db, email, user);

    // Bound in BOTH tenants — the old global unique would have blocked the 2nd.
    expect((await getSupplierForUser(db, tenantA, user))?.id).toBe(a);
    expect((await getSupplierForUser(db, tenantB, user))?.id).toBe(b);

    // Idempotent — a second bootstrap is a no-op, not a unique violation.
    await bindSupplierUserAllTenants(db, email, user);
    expect((await getSupplierForUser(db, tenantB, user))?.id).toBe(b);
  });

  it("still rejects binding the same user to two supplier rows WITHIN one tenant", async () => {
    const tenantId = await seedTenant();
    const a = (await createSupplier(db, tenantId, { name: "A", email: "one@wh.com" }))
      .id;
    const b = (await createSupplier(db, tenantId, { name: "B", email: "two@wh.com" }))
      .id;
    const user = randomUUID();
    await bindSupplierUser(db, tenantId, "one@wh.com", user);
    expect((await getSupplierForUser(db, tenantId, user))?.id).toBe(a);

    // Forcing the same uuid onto a 2nd row in the same tenant must violate
    // suppliers_tenant_user_unique.
    await expect(
      db.update(suppliers).set({ userDecisionUuid: user }).where(eq(suppliers.id, b)),
    ).rejects.toThrow();
  });

  it("listSupplierWorkspacesForUser returns every bound tenant, oldest-first", async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const email = "list@wh.com";
    await createSupplier(db, tenantA, { name: "Store A", email });
    await createSupplier(db, tenantB, { name: "Store B", email });
    const user = randomUUID();
    await bindSupplierUserAllTenants(db, email, user);

    const ws = await listSupplierWorkspacesForUser(db, user);
    const ids = ws.map((w) => w.id);
    expect(ids).toContain(tenantA);
    expect(ids).toContain(tenantB);
    // oldest-first: tenantA (seeded first) precedes tenantB.
    expect(ids.indexOf(tenantA)).toBeLessThan(ids.indexOf(tenantB));
    // Rows carry the WORKSPACE (tenant) projection — name + shopifyDomain.
    const rowA = ws.find((w) => w.id === tenantA)!;
    expect(rowA.name).toBe("Supplier Test");
    expect(rowA.shopifyDomain).toBeNull();
    // An unbound user sees nothing.
    expect(await listSupplierWorkspacesForUser(db, randomUUID())).toHaveLength(0);
  });

  it("listTenantsWithPendingSupplierInvitationForEmail returns tenants with a pending invite", async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const email = "pending@wh.com";
    const roleA = await ensureSupplierRole(db, tenantA);
    await createInvitation(db, tenantA, { email, roleId: roleA });
    // tenantB has a supplier row but NO pending invite.
    await createSupplier(db, tenantB, { name: "B", email });

    const tenantIds = await listTenantsWithPendingSupplierInvitationForEmail(
      db,
      "PENDING@wh.com",
    );
    expect(tenantIds).toContain(tenantA);
    expect(tenantIds).not.toContain(tenantB);
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

  // A case can escape `waiting_for_supplier` while the escalation is still open
  // (manual status change, "Take over", a manual reply resolving it, restart
  // from triage). The supplier's update must STILL re-engage the agent: every
  // status a person can park the case in flips back to `in_progress` so the
  // published `supplier.updated` event isn't held by a runtime park guard.
  it.each(["resolved", "human_takeover", "failed", "waiting_for_customer"])(
    "recordSupplierUpdate resumes a case that escaped to %s",
    async (escapedStatus) => {
      const tenantId = await seedTenant();
      const supplierId = (
        await createSupplier(db, tenantId, {
          name: "A",
          email: `esc-${escapedStatus}@wh.com`,
        })
      ).id;
      const caseId = await seedCase(tenantId, escapedStatus);
      const { id: escId } = await insertEscalation(db, {
        tenantId,
        caseId,
        supplierId,
        problem: "P",
        orderRef: null,
        shipCity: null,
        shipCountry: null,
        trackingNumber: null,
      });

      const res = await recordSupplierUpdate(db, {
        tenantId,
        supplierId,
        escalationId: escId,
        note: "Reshipped",
        proposedResolution: null,
        actorUuid: randomUUID(),
      });
      expect(res.kind).toBe("recorded");
      if (res.kind === "recorded") expect(res.resumed).toBe(true);

      const [row] = await db
        .select({ status: cases.status })
        .from(cases)
        .where(eq(cases.id, caseId));
      expect(row?.status).toBe("in_progress");

      const transitions = await db
        .select({
          from: caseStateTransitions.fromStatus,
          to: caseStateTransitions.toStatus,
        })
        .from(caseStateTransitions)
        .where(eq(caseStateTransitions.caseId, caseId));
      expect(
        transitions.some(
          (t) => t.from === escapedStatus && t.to === "in_progress",
        ),
      ).toBe(true);
    },
  );

  it("recordSupplierUpdate on an in_progress case records without a redundant flip", async () => {
    const tenantId = await seedTenant();
    const supplierId = (
      await createSupplier(db, tenantId, { name: "A", email: "a5@wh.com" })
    ).id;
    const caseId = await seedCase(tenantId, "in_progress");
    const { id: escId } = await insertEscalation(db, {
      tenantId,
      caseId,
      supplierId,
      problem: "P",
      orderRef: null,
      shipCity: null,
      shipCountry: null,
      trackingNumber: null,
    });
    const res = await recordSupplierUpdate(db, {
      tenantId,
      supplierId,
      escalationId: escId,
      note: "n",
      proposedResolution: null,
      actorUuid: randomUUID(),
    });
    expect(res.kind).toBe("recorded");
    if (res.kind === "recorded") expect(res.resumed).toBe(false);
    const [row] = await db
      .select({ status: cases.status, context: cases.context })
      .from(cases)
      .where(eq(cases.id, caseId));
    expect(row?.status).toBe("in_progress");
    expect(
      (row?.context as Record<string, unknown>)["supplierUpdate"],
    ).toBeTruthy();
    const transitions = await db
      .select({ id: caseStateTransitions.id })
      .from(caseStateTransitions)
      .where(eq(caseStateTransitions.caseId, caseId));
    expect(transitions).toHaveLength(0);
  });

  it("recordSupplierUpdate leaves a waiting_for_approval case parked (approval invariant)", async () => {
    const tenantId = await seedTenant();
    const supplierId = (
      await createSupplier(db, tenantId, { name: "A", email: "a6@wh.com" })
    ).id;
    const caseId = await seedCase(tenantId, "waiting_for_approval");
    const { id: escId } = await insertEscalation(db, {
      tenantId,
      caseId,
      supplierId,
      problem: "P",
      orderRef: null,
      shipCity: null,
      shipCountry: null,
      trackingNumber: null,
    });
    const res = await recordSupplierUpdate(db, {
      tenantId,
      supplierId,
      escalationId: escId,
      note: "n",
      proposedResolution: null,
      actorUuid: randomUUID(),
    });
    expect(res.kind).toBe("recorded");
    if (res.kind === "recorded") expect(res.resumed).toBe(false);
    const [row] = await db
      .select({ status: cases.status })
      .from(cases)
      .where(eq(cases.id, caseId));
    expect(row?.status).toBe("waiting_for_approval");
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

  // The notify outbox keys on the ESCALATION ROW (open + unsent), not on the
  // case sitting in `waiting_for_supplier`: under concurrent wait states a case
  // can carry an open escalation while parked `waiting_for_approval` (or
  // actively in_progress) and the supplier must still get the email. Cases a
  // human closed or owns are excluded — never email a supplier about those.
  it("listUnsentSupplierEscalations keys on open+unsent rows, excluding closed/owned cases", async () => {
    const tenantId = await seedTenant();
    const supplierId = (
      await createSupplier(db, tenantId, { name: "A", email: "outbox@wh.com" })
    ).id;

    const seedEscalated = async (caseStatus: string): Promise<string> => {
      const caseId = await seedCase(tenantId, caseStatus);
      const { id } = await insertEscalation(db, {
        tenantId,
        caseId,
        supplierId,
        problem: `P-${caseStatus}`,
        orderRef: null,
        shipCity: null,
        shipCountry: null,
        trackingNumber: null,
      });
      return id;
    };

    const parked = await seedEscalated("waiting_for_supplier");
    const approvalParked = await seedEscalated("waiting_for_approval");
    const active = await seedEscalated("in_progress");
    const resolved = await seedEscalated("resolved");
    const takenOver = await seedEscalated("human_takeover");
    const failed = await seedEscalated("failed");
    // An escalation the supplier already answered is never re-sent, even on a
    // still-parked case.
    const answered = await seedEscalated("waiting_for_supplier");
    await db
      .update(caseSupplierEscalations)
      .set({ status: "resolved", resolvedAt: new Date() })
      .where(eq(caseSupplierEscalations.id, answered));

    const listed = (await listUnsentSupplierEscalations(db, 100_000, 5)).filter(
      (r) => r.tenantId === tenantId,
    );
    const ids = listed.map((r) => r.id);
    expect(ids).toContain(parked);
    expect(ids).toContain(approvalParked);
    expect(ids).toContain(active);
    expect(ids).not.toContain(resolved);
    expect(ids).not.toContain(takenOver);
    expect(ids).not.toContain(failed);
    expect(ids).not.toContain(answered);
  });

  it("hasOpenEscalationForCase is true only while an OPEN row exists for that tenant+case", async () => {
    const tenantId = await seedTenant();
    const otherTenant = await seedTenant();
    const supplierId = (
      await createSupplier(db, tenantId, { name: "A", email: "open@wh.com" })
    ).id;
    const caseId = await seedCase(tenantId, "waiting_for_supplier");

    expect(await hasOpenEscalationForCase(db, tenantId, caseId)).toBe(false);

    const { id: escId } = await insertEscalation(db, {
      tenantId,
      caseId,
      supplierId,
      problem: "P",
      orderRef: null,
      shipCity: null,
      shipCountry: null,
      trackingNumber: null,
    });
    expect(await hasOpenEscalationForCase(db, tenantId, caseId)).toBe(true);
    // Tenant-scoped: another tenant asking about this case id sees nothing.
    expect(await hasOpenEscalationForCase(db, otherTenant, caseId)).toBe(false);

    await db
      .update(caseSupplierEscalations)
      .set({ status: "resolved", resolvedAt: new Date() })
      .where(eq(caseSupplierEscalations.id, escId));
    expect(await hasOpenEscalationForCase(db, tenantId, caseId)).toBe(false);
  });

  it("ensureSupplierRole creates a non-owner Supplier role granting the supplier perms (idempotent)", async () => {
    const tenantId = await seedTenant();
    const a = await ensureSupplierRole(db, tenantId);
    const b = await ensureSupplierRole(db, tenantId);
    expect(a).toBe(b);
    const supplierRoles = (await listRoles(db, tenantId)).filter(
      (r) => r.name === "Supplier",
    );
    expect(supplierRoles).toHaveLength(1);
    expect(supplierRoles[0]!.isOwner).toBe(false);
    expect([...supplierRoles[0]!.permissionIds].sort()).toEqual([
      "supplier.cases.respond",
      "supplier.cases.view",
    ]);
  });
});
