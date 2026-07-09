import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  approvals,
  auditLog,
  ticketAttachments,
  ticketSupplierEscalations,
  tickets,
  createInvitation,
  createSupplier,
  ensureSupplierRole,
  getSupplierByEmail,
  getSupplierForUser,
  insertEscalation,
  makeDbClient,
  memberInvitations,
  recordSupplierTrackingUpdate,
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
  // A SECOND merchant under a DIFFERENT WorkOS org — the cross-org supplier ticket.
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
    // children first (tickets cascade escalations; tenant cascade does the rest).
    // approvals.ticket_id is NO ACTION, so seeded approval rows go before tickets.
    await raw.db.delete(approvals).where(eq(approvals.tenantId, id));
    await raw.db.delete(tickets).where(eq(tickets.tenantId, id));
    await raw.db
      .delete(ticketSupplierEscalations)
      .where(eq(ticketSupplierEscalations.tenantId, id));
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
      "supplier.tickets.respond",
      "supplier.tickets.view",
    ]);

    // 3) Seed a parked ticket + an escalation for this supplier.
    const supplier = await getSupplierByEmail(raw.db, tenantId, "wh@acme.com");
    expect(supplier).not.toBeNull();
    const ticketId = randomUUID();
    await raw.db.insert(tickets).values({
      id: ticketId,
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
      ticketId,
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
      "/dashboard/supplier/tickets",
      supplierUuid,
      "wh@acme.com",
      tenantId,
    );
    expect(list.status).toBe(200);
    const listed = ((await list.json()) as { tickets: Array<Record<string, unknown>> })
      .tickets;
    expect(listed).toHaveLength(1);
    expect(Object.keys(listed[0]!).sort()).toEqual(
      [
        "ticketId",
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
      "/dashboard/supplier/tickets",
      adminUuid,
      "admin@acme.com",
      tenantId,
    );
    expect(ownerList.status).toBe(404);

    // 6) A signed-in stranger with no supplier binding → 404 (no disclosure) —
    // the binding check precedes decideSupplierAuthz (whose 403 path is unit-
    // tested in auth/tests/supplier-authz.test.ts).
    const stranger = await get(
      "/dashboard/supplier/tickets",
      strangerUuid,
      "stranger@acme.com",
      tenantId,
    );
    expect(stranger.status).toBe(404);

    // 7) Supplier posts an update → escalation resolved + ticket flipped, in ONE tx.
    const update = await post(
      `/dashboard/supplier/tickets/${escId}/update`,
      { note: "Reshipped via DHL; new ETA Friday.", proposedResolution: "reship" },
      supplierUuid,
      "wh@acme.com",
      tenantId,
    );
    expect(update.status).toBe(200);
    expect(((await update.json()) as { resumed: boolean }).resumed).toBe(true);

    const [escRow] = await raw.db
      .select({
        status: ticketSupplierEscalations.status,
        note: ticketSupplierEscalations.note,
      })
      .from(ticketSupplierEscalations)
      .where(eq(ticketSupplierEscalations.id, escId));
    expect(escRow?.status).toBe("resolved");
    expect(escRow?.note).toBe("Reshipped via DHL; new ETA Friday.");
    const [ticketRow] = await raw.db
      .select({ status: tickets.status })
      .from(tickets)
      .where(eq(tickets.id, ticketId));
    expect(ticketRow?.status).toBe("in_progress");

    // 8) A second submission on a resolved escalation is rejected.
    const again = await post(
      `/dashboard/supplier/tickets/${escId}/update`,
      { note: "again" },
      supplierUuid,
      "wh@acme.com",
      tenantId,
    );
    expect(again.status).toBe(409);

    // 9) An unknown escalation id → 404 (never discloses existence).
    const missing = await post(
      `/dashboard/supplier/tickets/${randomUUID()}/update`,
      { note: "x" },
      supplierUuid,
      "wh@acme.com",
      tenantId,
    );
    expect(missing.status).toBe(404);
  });

  // Supplier attachments: upload scoped to the supplier's own OPEN escalation,
  // then the update submission binds validated ids into the escalation's
  // context (and the event payload). Depends on the supplier binding created
  // by the e2e test above.
  it("uploads files to an open escalation and binds them to the update", async () => {
    if (!raw) return;
    const supplier = await getSupplierByEmail(raw.db, tenantId, "wh@acme.com");
    expect(supplier).not.toBeNull();
    const ticketId = randomUUID();
    await raw.db.insert(tickets).values({
      id: ticketId,
      tenantId,
      channel: "email",
      status: "waiting_for_supplier",
      currentAgentId: "missing-package-agent",
      context: { customerEmail: "cust@example.com" },
    });
    const { id: escId } = await insertEscalation(raw.db, {
      tenantId,
      ticketId,
      supplierId: supplier!.id,
      problem: "Damaged item — send replacement label",
      orderRef: "#2002",
      shipCity: null,
      shipCountry: null,
      trackingNumber: null,
    });

    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("bytes"),
    ]);
    const upload = await fetch(
      `${baseUrl}/dashboard/supplier/tickets/${escId}/attachments?filename=replacement-label.png`,
      {
        method: "POST",
        headers: {
          ...headers(supplierUuid, "wh@acme.com", tenantId),
          "content-type": "image/png",
        },
        body: png,
      },
    );
    expect(upload.status).toBe(200);
    const uploaded = (await upload.json()) as {
      attachment: { id: string; source: string; filename: string };
    };
    expect(uploaded.attachment.source).toBe("supplier");

    // A merchant-side upload on the same ticket is NOT referencable by the
    // supplier's update (source scoping) — the whole update is rejected.
    const [merchantRow] = await raw.db
      .insert(ticketAttachments)
      .values({
        id: randomUUID(),
        tenantId,
        ticketId,
        source: "merchant",
        filename: "internal.png",
        contentType: "image/png",
        sizeBytes: 5,
        storageKey: `upload/${tenantId}/${ticketId}/internal.png`,
      })
      .returning({ id: ticketAttachments.id });
    const crossSource = await post(
      `/dashboard/supplier/tickets/${escId}/update`,
      { note: "with someone else's file", attachmentIds: [merchantRow!.id] },
      supplierUuid,
      "wh@acme.com",
      tenantId,
    );
    expect(crossSource.status).toBe(400);
    expect(await crossSource.json()).toEqual({ error: "attachment_not_found" });

    // The real update, referencing the supplier's own upload.
    const update = await post(
      `/dashboard/supplier/tickets/${escId}/update`,
      {
        note: "Replacement shipped; label attached.",
        attachmentIds: [uploaded.attachment.id],
      },
      supplierUuid,
      "wh@acme.com",
      tenantId,
    );
    expect(update.status).toBe(200);

    const [ticketRow] = await raw.db
      .select({ context: tickets.context })
      .from(tickets)
      .where(eq(tickets.id, ticketId));
    const supplierUpdate = (ticketRow?.context as Record<string, unknown>)[
      "supplierUpdate"
    ] as { attachments?: ReadonlyArray<{ id: string; filename: string }> };
    expect(supplierUpdate.attachments).toEqual([
      { id: uploaded.attachment.id, filename: "replacement-label.png" },
    ]);

    // Upload onto the now-resolved escalation is refused.
    const late = await fetch(
      `${baseUrl}/dashboard/supplier/tickets/${escId}/attachments?filename=late.png`,
      {
        method: "POST",
        headers: {
          ...headers(supplierUuid, "wh@acme.com", tenantId),
          "content-type": "image/png",
        },
        body: png,
      },
    );
    expect(late.status).toBe(409);
  });

  // The agent must ALWAYS be re-engaged by a supplier update, even when the
  // ticket escaped `waiting_for_supplier` while the escalation was open (a human
  // resolved it / took it over) or is actively `in_progress`. Depends on the
  // supplier binding created by the e2e test above.
  it("re-engages the agent when the ticket escaped waiting_for_supplier", async () => {
    if (!raw) return;
    const supplier = await getSupplierByEmail(raw.db, tenantId, "wh@acme.com");
    expect(supplier).not.toBeNull();

    const seedEscalatedTicket = async (status: string) => {
      const ticketId = randomUUID();
      await raw.db.insert(tickets).values({
        id: ticketId,
        tenantId,
        channel: "email",
        status,
        currentAgentId: "missing-package-agent",
      });
      const { id: escId } = await insertEscalation(raw.db, {
        tenantId,
        ticketId,
        supplierId: supplier!.id,
        problem: "P",
        orderRef: null,
        shipCity: null,
        shipCountry: null,
        trackingNumber: null,
      });
      return { ticketId, escId };
    };

    // A ticket a human resolved while the supplier still owed an answer: the
    // update flips it back to in_progress AND publishes (resumed + ticked).
    const escaped = await seedEscalatedTicket("resolved");
    const res1 = await post(
      `/dashboard/supplier/tickets/${escaped.escId}/update`,
      { note: "Reshipped after all" },
      supplierUuid,
      "wh@acme.com",
      tenantId,
    );
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { resumed: boolean; ticked: boolean };
    expect(body1.resumed).toBe(true);
    expect(body1.ticked).toBe(true);
    const [row1] = await raw.db
      .select({ status: tickets.status })
      .from(tickets)
      .where(eq(tickets.id, escaped.ticketId));
    expect(row1?.status).toBe("in_progress");

    // A ticket that is actively in_progress: no status flip is needed, but the
    // event must STILL be published so the agent sees the supplier's answer.
    const active = await seedEscalatedTicket("in_progress");
    const res2 = await post(
      `/dashboard/supplier/tickets/${active.escId}/update`,
      { note: "Extra detail" },
      supplierUuid,
      "wh@acme.com",
      tenantId,
    );
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { resumed: boolean; ticked: boolean };
    expect(body2.resumed).toBe(false);
    expect(body2.ticked).toBe(true);
    const [row2] = await raw.db
      .select({ status: tickets.status })
      .from(tickets)
      .where(eq(tickets.id, active.ticketId));
    expect(row2?.status).toBe("in_progress");
  });

  // Redraft: a ticket parked `waiting_for_approval` with an open escalation
  // (concurrent wait states). The supplier's answer supersedes the pending
  // draft and resumes the ticket so the agent re-runs (resumed + ticked).
  it("redrafts a waiting_for_approval ticket: supersedes the pending draft and resumes", async () => {
    if (!raw) return;
    const supplier = await getSupplierByEmail(raw.db, tenantId, "wh@acme.com");
    expect(supplier).not.toBeNull();

    const ticketId = randomUUID();
    await raw.db.insert(tickets).values({
      id: ticketId,
      tenantId,
      channel: "email",
      status: "waiting_for_approval",
      currentAgentId: "missing-package-agent",
    });
    const approvalId = randomUUID();
    await raw.db.insert(approvals).values({
      id: approvalId,
      tenantId,
      ticketId,
      agentId: "missing-package-agent",
      tool: "conversation.reply",
      proposedInput: { draftId: approvalId, bodyText: "stale draft" },
      reasoning: "",
      riskLevel: "medium",
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const { id: escId } = await insertEscalation(raw.db, {
      tenantId,
      ticketId,
      supplierId: supplier!.id,
      problem: "P",
      orderRef: null,
      shipCity: null,
      shipCountry: null,
      trackingNumber: null,
    });

    const res = await post(
      `/dashboard/supplier/tickets/${escId}/update`,
      { note: "Reshipped; use tracking TRK9" },
      supplierUuid,
      "wh@acme.com",
      tenantId,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resumed: boolean; ticked: boolean };
    expect(body.resumed).toBe(true);
    expect(body.ticked).toBe(true);

    const [row] = await raw.db
      .select({ status: tickets.status })
      .from(tickets)
      .where(eq(tickets.id, ticketId));
    expect(row?.status).toBe("in_progress");

    // The stale draft was superseded (cancelled), not left pending.
    const [approval] = await raw.db
      .select({ status: approvals.status })
      .from(approvals)
      .where(eq(approvals.id, approvalId));
    expect(approval?.status).toBe("cancelled");

    const superseded = await raw.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.ticketId, ticketId),
          eq(auditLog.action, "approval.superseded"),
        ),
      );
    expect(superseded).toHaveLength(1);
  });

  // POST /dashboard/supplier/tickets/:id/tracking — the supplier fixes the
  // order's tracking number. The Shopify write itself is unit-tested
  // (supplier-tracking.test.ts + the provider suite); here we prove the HTTP
  // walls and the DB bookkeeping.
  it("guards the tracking edit: 400 bad input, 404 walls, 409 states", async () => {
    if (!raw) return;
    const supplier = await getSupplierByEmail(raw.db, tenantId, "wh@acme.com");
    expect(supplier).not.toBeNull();

    const seed = async (escStatus: "open" | "resolved") => {
      const ticketId = randomUUID();
      await raw.db.insert(tickets).values({
        id: ticketId,
        tenantId,
        channel: "email",
        status: "waiting_for_supplier",
        currentAgentId: "missing-package-agent",
        context: { customerEmail: "cust@example.com" },
      });
      const { id: escId } = await insertEscalation(raw.db, {
        tenantId,
        ticketId,
        supplierId: supplier!.id,
        problem: "P",
        orderRef: "#1001",
        shipCity: null,
        shipCountry: null,
        trackingNumber: "TRK-OLD",
      });
      if (escStatus === "resolved") {
        await raw.db
          .update(ticketSupplierEscalations)
          .set({ status: "resolved" })
          .where(eq(ticketSupplierEscalations.id, escId));
      }
      return { ticketId, escId };
    };

    const open = await seed("open");

    // Missing tracking number → 400.
    const bad = await post(
      `/dashboard/supplier/tickets/${open.escId}/tracking`,
      {},
      supplierUuid,
      "wh@acme.com",
      tenantId,
    );
    expect(bad.status).toBe(400);

    // Unknown escalation → 404 (no disclosure).
    const missing = await post(
      `/dashboard/supplier/tickets/${randomUUID()}/tracking`,
      { trackingNumber: "TRK-NEW" },
      supplierUuid,
      "wh@acme.com",
      tenantId,
    );
    expect(missing.status).toBe(404);

    // A stranger with no supplier binding → 404 (never 403).
    const stranger = await post(
      `/dashboard/supplier/tickets/${open.escId}/tracking`,
      { trackingNumber: "TRK-NEW" },
      strangerUuid,
      "stranger@acme.com",
      tenantId,
    );
    expect(stranger.status).toBe(404);

    // A resolved escalation is read-only → 409.
    const resolved = await seed("resolved");
    const late = await post(
      `/dashboard/supplier/tickets/${resolved.escId}/tracking`,
      { trackingNumber: "TRK-NEW" },
      supplierUuid,
      "wh@acme.com",
      tenantId,
    );
    expect(late.status).toBe(409);
    expect(((await late.json()) as { error: string }).error).toBe(
      "already_resolved",
    );

    // An open escalation whose ticket has no resolvable order (this test server
    // has no Shopify creds and the context binds no order) → 409, and no
    // tracking is stamped.
    const noOrder = await post(
      `/dashboard/supplier/tickets/${open.escId}/tracking`,
      { trackingNumber: "TRK-NEW", trackingCompany: "DHL" },
      supplierUuid,
      "wh@acme.com",
      tenantId,
    );
    expect(noOrder.status).toBe(409);
    expect(((await noOrder.json()) as { kind: string }).kind).toBe(
      "order_not_found",
    );
    const [escRow] = await raw.db
      .select({ trackingNumber: ticketSupplierEscalations.trackingNumber })
      .from(ticketSupplierEscalations)
      .where(eq(ticketSupplierEscalations.id, open.escId));
    expect(escRow?.trackingNumber).toBe("TRK-OLD");
  });

  // The post-write bookkeeping tx: escalation stamp + stale live-tracking cache
  // drop + audit row, atomically.
  it("recordSupplierTrackingUpdate stamps the escalation, drops the stale cache, and audits", async () => {
    if (!raw) return;
    const supplier = await getSupplierByEmail(raw.db, tenantId, "wh@acme.com");
    expect(supplier).not.toBeNull();

    const ticketId = randomUUID();
    await raw.db.insert(tickets).values({
      id: ticketId,
      tenantId,
      channel: "email",
      status: "waiting_for_supplier",
      currentAgentId: "missing-package-agent",
      context: {
        customerEmail: "cust@example.com",
        liveTrackingStatus: { trackingNumber: "TRK-OLD", carrier: "DHL" },
      },
    });
    const { id: escId } = await insertEscalation(raw.db, {
      tenantId,
      ticketId,
      supplierId: supplier!.id,
      problem: "P",
      orderRef: "#1001",
      shipCity: null,
      shipCountry: null,
      trackingNumber: "TRK-OLD",
    });

    await recordSupplierTrackingUpdate(raw.db, {
      tenantId,
      supplierId: supplier!.id,
      escalationId: escId,
      actorUuid: supplierUuid,
      fulfillmentId: "gid://shopify/Fulfillment/1",
      previousTrackingNumber: "TRK-OLD",
      trackingNumber: "TRK-NEW",
      trackingCompany: "UPS",
    });

    const [escRow] = await raw.db
      .select({ trackingNumber: ticketSupplierEscalations.trackingNumber })
      .from(ticketSupplierEscalations)
      .where(eq(ticketSupplierEscalations.id, escId));
    expect(escRow?.trackingNumber).toBe("TRK-NEW");

    const [ticketRow] = await raw.db
      .select({ context: tickets.context })
      .from(tickets)
      .where(eq(tickets.id, ticketId));
    const context = ticketRow?.context as Record<string, unknown>;
    // The stale lookup cache is gone; unrelated context keys survive.
    expect(context["liveTrackingStatus"]).toBeUndefined();
    expect(context["customerEmail"]).toBe("cust@example.com");

    const audits = await raw.db
      .select({ details: auditLog.details, actorId: auditLog.actorId })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.ticketId, ticketId),
          eq(auditLog.action, "supplier.tracking_updated"),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorId).toBe(supplierUuid);
    expect(audits[0]!.details).toMatchObject({
      escalationId: escId,
      previousTrackingNumber: "TRK-OLD",
      trackingNumber: "TRK-NEW",
      trackingCompany: "UPS",
    });
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

    // Seed a parked ticket + escalation in tenantB.
    const supplierB = await getSupplierForUser(raw.db, tenantB, supplierUuid);
    const ticketB = randomUUID();
    await raw.db.insert(tickets).values({
      id: ticketB,
      tenantId: tenantB,
      channel: "email",
      status: "waiting_for_supplier",
      currentAgentId: "missing-package-agent",
      context: { customerEmail: "custB@example.com" },
    });
    const { id: escB } = await insertEscalation(raw.db, {
      tenantId: tenantB,
      ticketId: ticketB,
      supplierId: supplierB!.id,
      problem: "Order #B22 stuck",
      orderRef: "#B22",
      shipCity: "Paris",
      shipCountry: "FR",
      trackingNumber: "TRK-B",
    });

    // Switching to tenantB is a pure x-workspace-id swap — the JWT is still orgA,
    // proving the supplier path never consults the org.
    const ticketsB = await get(
      "/dashboard/supplier/tickets",
      supplierUuid,
      "wh@acme.com",
      tenantB,
    );
    expect(ticketsB.status).toBe(200);
    const listedB = ((await ticketsB.json()) as {
      tickets: Array<Record<string, unknown>>;
    }).tickets;
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
    expect(permsB.permissions).toContain("supplier.tickets.view");

    // A workspace the supplier has NO binding for → 404 (disclosure-safe),
    // regardless of the JWT org.
    const unbound = await get(
      "/dashboard/supplier/tickets",
      supplierUuid,
      "wh@acme.com",
      randomUUID(),
    );
    expect(unbound.status).toBe(404);
  });
});
