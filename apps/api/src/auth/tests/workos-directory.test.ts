import { describe, expect, it, vi } from "vitest";

import {
  makeStaticWorkosOrgAdminDirectory,
  makeStaticWorkosOrganizationDirectory,
  makeStaticWorkosUserDirectory,
  makeWorkosOrgAdminDirectory,
  makeWorkosOrganizationDirectory,
  makeWorkosUserDirectory,
} from "../workos-directory.js";

// The api resolves a user's VERIFIED email from WorkOS (keyed on the verified
// `sub`) so invite reconciliation never trusts the spoofable x-user-email
// header. The lookup must fail soft — a WorkOS hiccup returns null (no
// reconcile) rather than throwing and breaking /me/session.
describe("makeWorkosUserDirectory (live)", () => {
  const okResponse = (email: unknown): Response =>
    ({ ok: true, json: async () => ({ email }) }) as unknown as Response;

  it("GETs the user-management user and returns its email + the right request", async () => {
    const fetchImpl = vi.fn(async () => okResponse("real@acme.com"));
    const dir = makeWorkosUserDirectory("sk_test_123", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await dir.getEmail("user_01ABC")).toBe("real@acme.com");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.workos.com/user_management/users/user_01ABC");
    expect((init.headers as Record<string, string>)["authorization"]).toBe(
      "Bearer sk_test_123",
    );
  });

  it("returns null on a non-2xx response (e.g. unknown user)", async () => {
    const dir = makeWorkosUserDirectory("sk", {
      fetchImpl: (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch,
    });
    expect(await dir.getEmail("user_x")).toBeNull();
  });

  it("returns null when the payload has no string email", async () => {
    const dir = makeWorkosUserDirectory("sk", {
      fetchImpl: (async () => okResponse(null)) as unknown as typeof fetch,
    });
    expect(await dir.getEmail("user_x")).toBeNull();
  });

  it("fails soft (null) when fetch throws — never breaks /me/session", async () => {
    const dir = makeWorkosUserDirectory("sk", {
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    });
    expect(await dir.getEmail("user_x")).toBeNull();
  });

  it("returns null for an empty id without calling out", async () => {
    const fetchImpl = vi.fn();
    const dir = makeWorkosUserDirectory("sk", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await dir.getEmail("")).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("makeStaticWorkosUserDirectory (test/inject)", () => {
  it("resolves from the provided map", async () => {
    const dir = makeStaticWorkosUserDirectory((id) =>
      id === "user_sam" ? "sam@acme.com" : null,
    );
    expect(await dir.getEmail("user_sam")).toBe("sam@acme.com");
    expect(await dir.getEmail("user_other")).toBeNull();
  });
});

// The admin console shows the WorkOS organization's human-readable name next to
// its opaque `org_…` id. The name lives only in WorkOS, so we resolve it from
// the organizations API. Like the user directory it fails SOFT — a hiccup
// returns null (show just the id) rather than breaking the tenant list.
describe("makeWorkosOrganizationDirectory (live)", () => {
  const okResponse = (name: unknown): Response =>
    ({ ok: true, json: async () => ({ name }) }) as unknown as Response;

  it("GETs the organization and returns its name + the right request", async () => {
    const fetchImpl = vi.fn(async () => okResponse("Acme Inc"));
    const dir = makeWorkosOrganizationDirectory("sk_test_123", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await dir.getName("org_01ABC")).toBe("Acme Inc");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.workos.com/organizations/org_01ABC");
    expect((init.headers as Record<string, string>)["authorization"]).toBe(
      "Bearer sk_test_123",
    );
  });

  it("returns null on a non-2xx response (e.g. unknown org)", async () => {
    const dir = makeWorkosOrganizationDirectory("sk", {
      fetchImpl: (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch,
    });
    expect(await dir.getName("org_x")).toBeNull();
  });

  it("returns null when the payload has no string name", async () => {
    const dir = makeWorkosOrganizationDirectory("sk", {
      fetchImpl: (async () => okResponse(null)) as unknown as typeof fetch,
    });
    expect(await dir.getName("org_x")).toBeNull();
  });

  it("fails soft (null) when fetch throws — never breaks the tenant list", async () => {
    const dir = makeWorkosOrganizationDirectory("sk", {
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    });
    expect(await dir.getName("org_x")).toBeNull();
  });

  it("returns null for an empty id without calling out", async () => {
    const fetchImpl = vi.fn();
    const dir = makeWorkosOrganizationDirectory("sk", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await dir.getName("")).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("makeStaticWorkosOrganizationDirectory (test/inject)", () => {
  it("resolves from the provided map", async () => {
    const dir = makeStaticWorkosOrganizationDirectory((id) =>
      id === "org_acme" ? "Acme Inc" : null,
    );
    expect(await dir.getName("org_acme")).toBe("Acme Inc");
    expect(await dir.getName("org_other")).toBeNull();
  });
});

// The org-admin directory WRITES to WorkOS (unlike the read-only user/org
// directories): create an org for a self-service signup, add the founder,
// resolve their existing memberships (idempotent onboarding), and send member/
// supplier invitations server-side so the Vite SPA — which has no WORKOS_API_KEY
// — no longer mints invitation ids in the browser. Same soft-fail contract:
// a create/invite that fails returns null (membership → false, list → []) so the
// caller decides (503 / retry / degrade) rather than the layer throwing.
describe("makeWorkosOrgAdminDirectory (live)", () => {
  const okJson = (body: unknown): Response =>
    ({ ok: true, json: async () => body }) as unknown as Response;

  it("createOrganization POSTs /organizations with the name and returns the id", async () => {
    const fetchImpl = vi.fn(async () => okJson({ id: "org_new_1", name: "Acme" }));
    const dir = makeWorkosOrgAdminDirectory("sk_test_123", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await dir.createOrganization("Acme")).toEqual({ id: "org_new_1" });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.workos.com/organizations");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["authorization"]).toBe(
      "Bearer sk_test_123",
    );
    expect(JSON.parse(init.body as string)).toEqual({ name: "Acme" });
  });

  it("createOrganization fails soft (null) on non-2xx and on throw", async () => {
    const bad = makeWorkosOrgAdminDirectory("sk", {
      fetchImpl: (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch,
    });
    expect(await bad.createOrganization("X")).toBeNull();
    const boom = makeWorkosOrgAdminDirectory("sk", {
      fetchImpl: (async () => {
        throw new Error("network");
      }) as unknown as typeof fetch,
    });
    expect(await boom.createOrganization("X")).toBeNull();
  });

  it("addOrganizationMembership POSTs user_id+organization_id and returns true", async () => {
    const fetchImpl = vi.fn(async () => okJson({ id: "om_1" }));
    const dir = makeWorkosOrgAdminDirectory("sk", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await dir.addOrganizationMembership("org_1", "user_1")).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.workos.com/user_management/organization_memberships",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      organization_id: "org_1",
      user_id: "user_1",
    });
  });

  it("addOrganizationMembership returns false on failure", async () => {
    const dir = makeWorkosOrgAdminDirectory("sk", {
      fetchImpl: (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch,
    });
    expect(await dir.addOrganizationMembership("org_1", "user_1")).toBe(false);
  });

  it("listOrganizationMemberships GETs active memberships and returns the org ids", async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({
        data: [
          { organization_id: "org_a" },
          { organization_id: "org_b" },
        ],
      }),
    );
    const dir = makeWorkosOrgAdminDirectory("sk", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await dir.listOrganizationMemberships("user_1")).toEqual([
      "org_a",
      "org_b",
    ]);
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.workos.com/user_management/organization_memberships?user_id=user_1&statuses=active",
    );
  });

  it("listOrganizationMemberships returns null on a LOOKUP FAILURE (not []), so onboarding can't mistake it for 'no orgs'", async () => {
    const threw = makeWorkosOrgAdminDirectory("sk", {
      fetchImpl: (async () => {
        throw new Error("network");
      }) as unknown as typeof fetch,
    });
    expect(await threw.listOrganizationMemberships("user_1")).toBeNull();
    const non2xx = makeWorkosOrgAdminDirectory("sk", {
      fetchImpl: (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch,
    });
    expect(await non2xx.listOrganizationMemberships("user_1")).toBeNull();
  });

  it("sendInvitation POSTs /user_management/invitations and returns the id", async () => {
    const fetchImpl = vi.fn(async () => okJson({ id: "invitation_1" }));
    const dir = makeWorkosOrgAdminDirectory("sk", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(
      await dir.sendInvitation({
        email: "sam@acme.com",
        organizationId: "org_1",
        inviterUserId: "user_boss",
      }),
    ).toEqual({ id: "invitation_1" });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.workos.com/user_management/invitations");
    expect(JSON.parse(init.body as string)).toEqual({
      email: "sam@acme.com",
      organization_id: "org_1",
      inviter_user_id: "user_boss",
    });
  });

  it("sendInvitation omits inviter_user_id when not given and fails soft", async () => {
    const fetchImpl = vi.fn(async () => okJson({ id: "invitation_2" }));
    const dir = makeWorkosOrgAdminDirectory("sk", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await dir.sendInvitation({ email: "a@b.com", organizationId: "org_1" });
    expect(JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string)).toEqual({
      email: "a@b.com",
      organization_id: "org_1",
    });
    const bad = makeWorkosOrgAdminDirectory("sk", {
      fetchImpl: (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch,
    });
    expect(
      await bad.sendInvitation({ email: "a@b.com", organizationId: "org_1" }),
    ).toBeNull();
  });
});

describe("makeStaticWorkosOrgAdminDirectory (test/inject)", () => {
  it("delegates to the provided resolvers with safe defaults", async () => {
    const dir = makeStaticWorkosOrgAdminDirectory({
      createOrganization: (name) => ({ id: `org_${name}` }),
      listOrganizationMemberships: (u) => (u === "known" ? ["org_x"] : []),
    });
    expect(await dir.createOrganization("acme")).toEqual({ id: "org_acme" });
    expect(await dir.listOrganizationMemberships("known")).toEqual(["org_x"]);
    // Unspecified methods use safe defaults (membership true, invite id echoed).
    expect(await dir.addOrganizationMembership("org_1", "user_1")).toBe(true);
    expect(
      await dir.sendInvitation({ email: "a@b.com", organizationId: "org_1" }),
    ).not.toBeNull();
  });
});
