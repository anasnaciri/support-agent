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
import {
  TEST_DASHBOARD_VERIFIER,
  dashboardAuthHeaders,
  decisionUuidFor,
} from "../src/tests/support/dashboard-auth.js";
import { makeStaticWorkosUserDirectory } from "../src/auth/workos-directory.js";
import type { ApiConfig } from "../src/bootstrap.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("apps/api — member RBAC (integration)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;

  // Separate tenant per scenario so auto-claim (which flips a workspace to
  // enforced) doesn't bleed across tests.
  const orgOpen = `org_${randomUUID().slice(0, 8)}`;
  const orgScoped = `org_${randomUUID().slice(0, 8)}`;
  const tenantOpen = randomUUID();
  const tenantScoped = randomUUID();
  const tenantIds = [tenantOpen, tenantScoped];

  // S14: the api derives the member decision UUID from the verified `sub`. Tests
  // pick a WorkOS user id per actor; the assignment-key UUID is the hash of it,
  // and the headers helper encodes the WorkOS id back into the forwarded bearer.
  const adminWorkos = "user_rbac_admin";
  const samWorkos = "user_rbac_sam";
  const malloryWorkos = "user_rbac_mallory";
  const adminUuid = decisionUuidFor(adminWorkos);
  const samUuid = decisionUuidFor(samWorkos);
  const malloryUuid = decisionUuidFor(malloryWorkos);
  const workosByUuid: Record<string, string> = {
    [adminUuid]: adminWorkos,
    [samUuid]: samWorkos,
    [malloryUuid]: malloryWorkos,
  };
  // The VERIFIED email each WorkOS user resolves to (what the api looks up from
  // `sub`). Mallory's verified email is her own — she cannot become sam by
  // spoofing the x-user-email header.
  const verifiedEmailByWorkos: Record<string, string> = {
    [adminWorkos]: "admin@acme.com",
    [samWorkos]: "sam@acme.com",
    [malloryWorkos]: "mallory@acme.com",
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

  // `userId` is the decision UUID the test reasons about (assignment key); we
  // reverse it to the WorkOS id the bearer carries so the api re-derives the
  // same UUID. With no actor, the bearer carries a default (unassigned) user.
  const headers = (
    org: string,
    userId?: string,
    email?: string,
  ): Record<string, string> =>
    dashboardAuthHeaders(
      org,
      {
        "content-type": "application/json",
        ...(email ? { "x-user-email": email } : {}),
      },
      userId ? (workosByUuid[userId] ?? userId) : "user_unassigned",
    );
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
    handle = await startServer(cfg, {
      dashboardTokenVerifier: TEST_DASHBOARD_VERIFIER,
      workosUserDirectory: directory,
    });
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

  it("open mode allows any gated read, even for an unassigned actor", async () => {
    // No assignments yet → open. A read by an actor with no assignment works.
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

    // SPOOF: Mallory (verified mallory@acme.com) hits /me/session while spoofing
    // the x-user-email header as sam@acme.com. The api reconciles against her
    // VERIFIED email, not the header — so she does NOT inherit Sam's invite.
    const mallorySession = await post(
      "/dashboard/me/session",
      {},
      orgScoped,
      malloryUuid,
      "sam@acme.com",
    );
    expect(mallorySession.status).toBe(200);
    const mallory = (await mallorySession.json()) as {
      assigned: boolean;
      permissions: string[];
    };
    expect(mallory.assigned).toBe(false);
    expect(mallory.permissions).toEqual([]);

    // Sam's first load reconciles the invite into an assignment. (Still pending
    // — Mallory's spoof did not consume it.)
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

    // In ENFORCED mode an authenticated actor with no assignment is 403.
    expect((await get("/dashboard/today", orgScoped)).status).toBe(403);
    // …and a request with no verified token at all is 401.
    expect(
      (await fetch(`${baseUrl}/dashboard/today`, { headers: {} })).status,
    ).toBe(401);

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
