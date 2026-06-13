import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  makeDbClient,
  memberInvitations,
  memberRoleAssignments,
  rolePermissions,
  roles,
  tenants,
} from "@support-agent/db";
import { startServer, type ServerHandle } from "../src/server.js";
import type { ApiConfig } from "../src/bootstrap.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("apps/api — member RBAC (integration)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const token = "dash-rbac-token";

  // Separate tenant per scenario so auto-claim (which flips a workspace to
  // enforced) doesn't bleed across tests.
  const orgOpen = `org_${randomUUID().slice(0, 8)}`;
  const orgScoped = `org_${randomUUID().slice(0, 8)}`;
  const tenantOpen = randomUUID();
  const tenantScoped = randomUUID();
  const tenantIds = [tenantOpen, tenantScoped];

  const adminUuid = randomUUID();
  const samUuid = randomUUID();

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
    dashboardApiToken: token,
  } as ApiConfig;

  let handle: ServerHandle | null = null;
  let baseUrl = "";

  const headers = (
    org: string,
    userId?: string,
    email?: string,
  ): Record<string, string> => ({
    authorization: `Bearer ${token}`,
    "x-org-id": org,
    "content-type": "application/json",
    ...(userId ? { "x-user-id": userId } : {}),
    ...(email ? { "x-user-email": email } : {}),
  });
  const get = (
    path: string,
    org: string,
    userId?: string,
    email?: string,
  ): Promise<Response> =>
    fetch(`${baseUrl}${path}`, { headers: headers(org, userId, email) });
  const post = (
    path: string,
    body: unknown,
    org: string,
    userId?: string,
    email?: string,
  ): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: headers(org, userId, email),
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    if (!raw) return;
    await raw.db.insert(tenants).values([
      { id: tenantOpen, name: "RBAC-open", workosOrganizationId: orgOpen },
      { id: tenantScoped, name: "RBAC-scoped", workosOrganizationId: orgScoped },
    ]);
    handle = await startServer(cfg);
    baseUrl = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    if (!raw) return;
    if (handle) await handle.close();
    for (const id of tenantIds) {
      // children first (FK restrict on assignments→roles)
      await raw.db
        .delete(memberInvitations)
        .where(sql`${memberInvitations.tenantId} = ${id}`);
      await raw.db
        .delete(memberRoleAssignments)
        .where(sql`${memberRoleAssignments.tenantId} = ${id}`);
      await raw.db.delete(rolePermissions).where(
        sql`${rolePermissions.roleId} IN (SELECT id FROM roles WHERE tenant_id = ${id})`,
      );
      await raw.db.delete(roles).where(sql`${roles.tenantId} = ${id}`);
      await raw.db.delete(tenants).where(sql`${tenants.id} = ${id}`);
    }
    await raw.close();
  });

  it("open mode allows any gated read, even without an actor id", async () => {
    // No assignments yet → open. A legacy read without x-user-id still works.
    expect((await get("/dashboard/audit", orgOpen)).status).toBe(200);
    expect(
      (await get("/dashboard/today", orgOpen, adminUuid, "admin@acme.com")).status,
    ).toBe(200);
  });

  it("me/session reports all permissions + assigned=false in open mode", async () => {
    const res = await post(
      "/dashboard/me/session",
      {},
      orgOpen,
      adminUuid,
      "admin@acme.com",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      isOwner: boolean;
      assigned: boolean;
      permissions: string[];
    };
    expect(body.assigned).toBe(false);
    expect(body.permissions).toContain("audit.view");
    expect(body.permissions).toContain("members.manage");
  });

  it("enforces scoped roles end-to-end (invite → reconcile → gated access)", async () => {
    // Admin creates a role — this auto-claims Owner for the admin, flipping the
    // workspace to enforced mode.
    const created = await post(
      "/dashboard/roles",
      { name: "Support" },
      orgScoped,
      adminUuid,
      "admin@acme.com",
    );
    expect(created.status).toBe(200);
    const roleId = ((await created.json()) as { roleId: string }).roleId;

    // Grant only cases.view + cases.reply.
    const setPerms = await post(
      `/dashboard/roles/${roleId}/permissions`,
      { permissionIds: ["cases.view", "cases.reply"] },
      orgScoped,
      adminUuid,
      "admin@acme.com",
    );
    expect(setPerms.status).toBe(200);

    // Admin is now an Owner (auto-claimed).
    const membersRes = await get(
      "/dashboard/members",
      orgScoped,
      adminUuid,
      "admin@acme.com",
    );
    expect(membersRes.status).toBe(200);
    const members = ((await membersRes.json()) as {
      members: { userDecisionUuid: string; isOwner: boolean }[];
    }).members;
    expect(members.find((m) => m.userDecisionUuid === adminUuid)?.isOwner).toBe(
      true,
    );

    // Invite Sam to the Support role.
    const invite = await post(
      "/dashboard/members/invite",
      { email: "sam@acme.com", roleId },
      orgScoped,
      adminUuid,
      "admin@acme.com",
    );
    expect(invite.status).toBe(200);

    // Sam's first load reconciles the invite into an assignment.
    const samSession = await post(
      "/dashboard/me/session",
      {},
      orgScoped,
      samUuid,
      "sam@acme.com",
    );
    expect(samSession.status).toBe(200);
    const sam = (await samSession.json()) as {
      isOwner: boolean;
      assigned: boolean;
      permissions: string[];
    };
    expect(sam.assigned).toBe(true);
    expect(sam.isOwner).toBe(false);
    expect([...sam.permissions].sort()).toEqual(["cases.reply", "cases.view"]);

    // Sam can read cases…
    expect(
      (await get("/dashboard/today", orgScoped, samUuid, "sam@acme.com")).status,
    ).toBe(200);
    // …but not the audit log, AI provider, or member management.
    expect(
      (await get("/dashboard/audit", orgScoped, samUuid, "sam@acme.com")).status,
    ).toBe(403);
    expect(
      (await get("/dashboard/llm", orgScoped, samUuid, "sam@acme.com")).status,
    ).toBe(403);
    expect(
      (await get("/dashboard/members", orgScoped, samUuid, "sam@acme.com")).status,
    ).toBe(403);
    expect(
      (
        await post(
          "/dashboard/members/invite",
          { email: "x@acme.com", roleId },
          orgScoped,
          samUuid,
          "sam@acme.com",
        )
      ).status,
    ).toBe(403);

    // In ENFORCED mode a guarded read without an actor id is 401.
    expect((await get("/dashboard/today", orgScoped)).status).toBe(401);

    // Role deletion guards: in use → 409.
    expect(
      (
        await post(
          `/dashboard/roles/${roleId}/delete`,
          {},
          orgScoped,
          adminUuid,
          "admin@acme.com",
        )
      ).status,
    ).toBe(409);

    // Remove Sam, then the role deletes.
    expect(
      (
        await post(
          `/dashboard/members/${samUuid}/remove`,
          {},
          orgScoped,
          adminUuid,
          "admin@acme.com",
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await post(
          `/dashboard/roles/${roleId}/delete`,
          {},
          orgScoped,
          adminUuid,
          "admin@acme.com",
        )
      ).status,
    ).toBe(200);
  });
});
