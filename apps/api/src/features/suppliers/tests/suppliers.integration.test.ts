import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  caseSupplierEscalations,
  cases,
  createInvitation,
  createSupplier,
  ensureSupplierRole,
  getSupplierByEmail,
  getSupplierForUser,
  insertEscalation,
  makeDbClient,
  memberInvitations,
  memberRoleAssignments,
  rolePermissions,
  roles,
  suppliers,
  tenants,
} from "@support-agent/db";
import { startServer, type ServerHandle } from "../../../server.js";
import {
  TEST_DASHBOARD_VERIFIER,
  dashboardAuthHeaders,
  decisionUuidFor,
} from "../../../tests/support/dashboard-auth.js";
import { makeStaticWorkosUserDirectory } from "../../../auth/workos-directory.js";
import type { ApiConfig } from "../../../bootstrap.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("apps/api — supplier portal (integration)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;

  const org = `org_${randomUUID().slice(0, 8)}`;
  const tenantId = randomUUID();
  // A SECOND merchant under a DIFFERENT WorkOS org — the cross-org supplier case.
  const orgB = `org_${randomUUID().slice(0, 8)}`;
  const tenantB = randomUUID();

  const adminWorkos = "user_sup_admin";
  const supplierWorkos = "user_sup_wh";
  const strangerWorkos = "user_sup_stranger";
  const adminUuid = decisionUuidFor(adminWorkos);
  const supplierUuid = decisionUuidFor(supplierWorkos);
  const strangerUuid = decisionUuidFor(strangerWorkos);
  const workosByUuid: Record<string, string> = {
    [adminUuid]: adminWorkos,
    [supplierUuid]: supplierWorkos,
    [strangerUuid]: strangerWorkos,
  };
  const verifiedEmailByWorkos: Record<string, string> = {
    [adminWorkos]: "admin@acme.com",
    [supplierWorkos]: "wh@acme.com",
    [strangerWorkos]: "stranger@acme.com",
  };
  const directory = makeStaticWorkosUserDirectory(
    (id) => verifiedEmailByWorkos[id] ?? null,
  );

  const cfg = {
    port: 0,
    databaseUrl: databaseUrl!,
    encryptionKey: randomBytes(32),
    stateSigningKey: "k",
    shopify: {
      clientId: "c",
      clientSecret: "s",
      callbackUrl: "http://localhost/shopify/auth/callback",
      apiVersion: "2025-01",
    },
    google: {
      clientId: "g",
      clientSecret: "gs",
      callbackUrl: "http://localhost/google/auth/callback",
      pubsubTopic: null,
      pushToken: null,
    },
    approvalSigningKey: "a",
    dashboardBaseUrl: null,
    workos: null,
  } as ApiConfig;

  let handle: ServerHandle | null = null;
  let baseUrl = "";

  const headers = (
    userId?: string,
    email?: string,
    workspaceId?: string,
  ): Record<string, string> =>
    dashboardAuthHeaders(
      org,
      {
        "content-type": "application/json",
        ...(email ? { "x-user-email": email } : {}),
        // The supplier portal pins the active workspace by header; the JWT org
        // stays `org` (orgA) so the cross-org calls prove org is not consulted.
        ...(workspaceId ? { "x-workspace-id": workspaceId } : {}),
      },
      userId ? (workosByUuid[userId] ?? userId) : "user_unassigned",
    );
  const get = (
    path: string,
    userId?: string,
    email?: string,
    workspaceId?: string,
  ): Promise<Response> =>
    fetch(`${baseUrl}${path}`, { headers: headers(userId, email, workspaceId) });
  const post = (
    path: string,
    body: unknown,
    userId?: string,
    email?: string,
    workspaceId?: string,
  ): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: headers(userId, email, workspaceId),
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    if (!raw) return;
    await raw.db
      .insert(tenants)
      .values({ id: tenantId, name: "Supplier-int", workosOrganizationId: org });
    await raw.db
      .insert(tenants)
      .values({ id: tenantB, name: "Supplier-int-B", workosOrganizationId: orgB });
    handle = await startServer(cfg, {
      dashboardTokenVerifier: TEST_DASHBOARD_VERIFIER,
      workosUserDirectory: directory,
    });
    baseUrl = `http://localhost:${handle.port}`;
  });

  const cleanupTenant = async (id: string): Promise<void> => {
    if (!raw) return;
    // children first (cases cascade escalations; tenant cascade does the rest).
    await raw.db.delete(cases).where(eq(cases.tenantId, id));
    await raw.db
      .delete(caseSupplierEscalations)
      .where(eq(caseSupplierEscalations.tenantId, id));
    await raw.db.delete(suppliers).where(eq(suppliers.tenantId, id));
    await raw.db
      .delete(memberInvitations)
      .where(eq(memberInvitations.tenantId, id));
    await raw.db
      .delete(memberRoleAssignments)
      .where(eq(memberRoleAssignments.tenantId, id));
    await raw.db
      .delete(rolePermissions)
      .where(
        sql`${rolePermissions.roleId} IN (SELECT id FROM roles WHERE tenant_id = ${id})`,
      );
    await raw.db.delete(roles).where(eq(roles.tenantId, id));
    await raw.db.delete(tenants).where(eq(tenants.id, id));
  };

  afterAll(async () => {
    if (!raw) return;
    if (handle) await handle.close();
    await cleanupTenant(tenantId);
    await cleanupTenant(tenantB);
    await raw.close();
  });

  it("runs the supplier loop end-to-end with privacy + isolation", async () => {
    if (!raw) return;

    // 1) Merchant invites a supplier (auto-claims Owner, ensures Supplier role).
    const invite = await post(
      "/dashboard/supplier/invite",
      { email: "wh@acme.com", name: "Acme Warehouse" },
      adminUuid,
      "admin@acme.com",
    );
    expect(invite.status).toBe(200);

    // 2) Supplier's first /me/session reconciles the invite + binds the row.
    const session = await post(
      "/dashboard/me/session",
      {},
      supplierUuid,
      "wh@acme.com",
    );
    expect(session.status).toBe(200);
    const sess = (await session.json()) as {
      assigned: boolean;
      permissions: string[];
    };
    expect(sess.assigned).toBe(true);
    expect([...sess.permissions].sort()).toEqual([
      "supplier.cases.respond",
      "supplier.cases.view",
    ]);

    // 3) Seed a parked case + an escalation for this supplier.
    const supplier = await getSupplierByEmail(raw.db, tenantId, "wh@acme.com");
    expect(supplier).not.toBeNull();
    const caseId = randomUUID();
    await raw.db.insert(cases).values({
      id: caseId,
      tenantId,
      channel: "email",
      status: "waiting_for_supplier",
      currentAgentId: "missing-package-agent",
      threadId: "gmail:thread-1",
      provider: "gmail",
      mailbox: "support@acme.com",
      context: { customerEmail: "cust@example.com" },
    });
    const { id: escId } = await insertEscalation(raw.db, {
      tenantId,
      caseId,
      supplierId: supplier!.id,
      problem: "Order #1001 to Berlin, DE stuck 12 days — please chase or reship",
      orderRef: "#1001",
      shipCity: "Berlin",
      shipCountry: "DE",
      trackingNumber: "TRK-1",
    });

    // 4) Supplier sees ONLY the minimal projection — no customer PII. Pins the
    // active workspace by header (binding-anchored auth requires x-workspace-id).
    const list = await get(
      "/dashboard/supplier/cases",
      supplierUuid,
      "wh@acme.com",
      tenantId,
    );
    expect(list.status).toBe(200);
    const listed = ((await list.json()) as { cases: Array<Record<string, unknown>> })
      .cases;
    expect(listed).toHaveLength(1);
    expect(Object.keys(listed[0]!).sort()).toEqual(
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
    expect(JSON.stringify(listed[0])).not.toContain("cust@example.com");

    // 5) Owner previewing the supplier surface has no supplier binding for this
    // workspace → 404 (binding-anchored auth; disclosure-safe, not an empty 200).
    const ownerList = await get(
      "/dashboard/supplier/cases",
      adminUuid,
      "admin@acme.com",
      tenantId,
    );
    expect(ownerList.status).toBe(404);

    // 6) A signed-in stranger with no supplier binding → 404 (no disclosure) —
    // the binding check precedes decideSupplierAuthz (whose 403 path is unit-
    // tested in auth/tests/supplier-authz.test.ts).
    const stranger = await get(
      "/dashboard/supplier/cases",
      strangerUuid,
      "stranger@acme.com",
      tenantId,
    );
    expect(stranger.status).toBe(404);

    // 7) Supplier posts an update → escalation resolved + case flipped, in ONE tx.
    const update = await post(
      `/dashboard/supplier/cases/${escId}/update`,
      { note: "Reshipped via DHL; new ETA Friday.", proposedResolution: "reship" },
      supplierUuid,
      "wh@acme.com",
      tenantId,
    );
    expect(update.status).toBe(200);
    expect(((await update.json()) as { resumed: boolean }).resumed).toBe(true);

    const [escRow] = await raw.db
      .select({
        status: caseSupplierEscalations.status,
        note: caseSupplierEscalations.note,
      })
      .from(caseSupplierEscalations)
      .where(eq(caseSupplierEscalations.id, escId));
    expect(escRow?.status).toBe("resolved");
    expect(escRow?.note).toBe("Reshipped via DHL; new ETA Friday.");
    const [caseRow] = await raw.db
      .select({ status: cases.status })
      .from(cases)
      .where(eq(cases.id, caseId));
    expect(caseRow?.status).toBe("in_progress");

    // 8) A second submission on a resolved escalation is rejected.
    const again = await post(
      `/dashboard/supplier/cases/${escId}/update`,
      { note: "again" },
      supplierUuid,
      "wh@acme.com",
      tenantId,
    );
    expect(again.status).toBe(409);

    // 9) An unknown escalation id → 404 (never discloses existence).
    const missing = await post(
      `/dashboard/supplier/cases/${randomUUID()}/update`,
      { note: "x" },
      supplierUuid,
      "wh@acme.com",
      tenantId,
    );
    expect(missing.status).toBe(404);
  });

  it("binds a supplier across ORGS + switches by x-workspace-id (org not consulted)", async () => {
    if (!raw) return;

    // tenantB is a DIFFERENT merchant under a DIFFERENT WorkOS org (orgB). Seed
    // the Supplier role + supplier row + a PENDING invite for the same person.
    const roleB = await ensureSupplierRole(raw.db, tenantB);
    await createSupplier(raw.db, tenantB, {
      name: "Acme Warehouse",
      email: "wh@acme.com",
    });
    const inv = await createInvitation(raw.db, tenantB, {
      email: "wh@acme.com",
      roleId: roleB,
    });
    expect(inv.ok).toBe(true);

    // The supplier's JWT org is `org` (orgA). Hitting the identity-only bootstrap
    // binds them to tenantB's row AND reconciles the pending invite (creating the
    // per-tenant Supplier assignment) — WITHOUT ever switching WorkOS orgs.
    const wsRes = await get(
      "/dashboard/supplier/workspaces",
      supplierUuid,
      "wh@acme.com",
    );
    expect(wsRes.status).toBe(200);
    const { workspaces } = (await wsRes.json()) as {
      workspaces: Array<{ id: string; name: string }>;
    };
    const wsIds = workspaces.map((w) => w.id);
    // Both merchants show up — tenantA (bound in the first test) + cross-org tenantB.
    expect(wsIds).toContain(tenantId);
    expect(wsIds).toContain(tenantB);

    // The cross-tenant reconcile created the Supplier role assignment in tenantB.
    const assignB = await raw.db
      .select({ uuid: memberRoleAssignments.userDecisionUuid })
      .from(memberRoleAssignments)
      .where(
        and(
          eq(memberRoleAssignments.tenantId, tenantB),
          eq(memberRoleAssignments.userDecisionUuid, supplierUuid),
        ),
      );
    expect(assignB).toHaveLength(1);
    // And the binding is now resolvable in tenantB.
    expect(await getSupplierForUser(raw.db, tenantB, supplierUuid)).not.toBeNull();

    // Seed a parked case + escalation in tenantB.
    const supplierB = await getSupplierForUser(raw.db, tenantB, supplierUuid);
    const caseB = randomUUID();
    await raw.db.insert(cases).values({
      id: caseB,
      tenantId: tenantB,
      channel: "email",
      status: "waiting_for_supplier",
      currentAgentId: "missing-package-agent",
      context: { customerEmail: "custB@example.com" },
    });
    const { id: escB } = await insertEscalation(raw.db, {
      tenantId: tenantB,
      caseId: caseB,
      supplierId: supplierB!.id,
      problem: "Order #B22 stuck",
      orderRef: "#B22",
      shipCity: "Paris",
      shipCountry: "FR",
      trackingNumber: "TRK-B",
    });

    // Switching to tenantB is a pure x-workspace-id swap — the JWT is still orgA,
    // proving the supplier path never consults the org.
    const casesB = await get(
      "/dashboard/supplier/cases",
      supplierUuid,
      "wh@acme.com",
      tenantB,
    );
    expect(casesB.status).toBe(200);
    const listedB = ((await casesB.json()) as {
      cases: Array<Record<string, unknown>>;
    }).cases;
    expect(listedB).toHaveLength(1);
    expect(listedB[0]!["id"]).toBe(escB);

    // Binding-anchored per-workspace permissions for the switcher.
    const sessB = await get(
      "/dashboard/supplier/session",
      supplierUuid,
      "wh@acme.com",
      tenantB,
    );
    expect(sessB.status).toBe(200);
    const permsB = (await sessB.json()) as { permissions: string[] };
    expect(permsB.permissions).toContain("supplier.cases.view");

    // A workspace the supplier has NO binding for → 404 (disclosure-safe),
    // regardless of the JWT org.
    const unbound = await get(
      "/dashboard/supplier/cases",
      supplierUuid,
      "wh@acme.com",
      randomUUID(),
    );
    expect(unbound.status).toBe(404);
  });
});
