// Resolve a user's VERIFIED email from WorkOS, keyed on the verified `sub`.
//
// S14 left `x-user-email` as a forwarded (low-trust) header. The /me/session
// invite-reconcile keys on it, so an authenticated member could otherwise
// reconcile a pending invite addressed to ANOTHER email within their own org
// and claim its role. This directory looks the email up server-side from the
// WorkOS user-management API so reconcile never trusts a caller header.
//
// Lookups fail SOFT: any error / non-2xx returns null. A WorkOS hiccup then
// means "don't reconcile this load" (the invite stays pending, retried next
// load) rather than breaking the dashboard's context fetch.

export interface WorkosUserDirectory {
  /** The user's email, or null (unknown user / not configured / lookup failed). */
  getEmail(workosUserId: string): Promise<string | null>;
}

type FetchFn = typeof fetch;

export const makeWorkosUserDirectory = (
  apiKey: string,
  opts: { readonly baseUrl?: string; readonly fetchImpl?: FetchFn } = {},
): WorkosUserDirectory => {
  const base = (opts.baseUrl ?? "https://api.workos.com").replace(/\/+$/u, "");
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async getEmail(workosUserId) {
      if (!workosUserId) return null;
      try {
        const res = await doFetch(
          `${base}/user_management/users/${encodeURIComponent(workosUserId)}`,
          { headers: { authorization: `Bearer ${apiKey}` } },
        );
        if (!res.ok) return null;
        const body = (await res.json()) as { email?: unknown };
        return typeof body.email === "string" && body.email.length > 0
          ? body.email
          : null;
      } catch {
        return null;
      }
    },
  };
};

/** Test / injection directory backed by a plain resolver. */
export const makeStaticWorkosUserDirectory = (
  resolve: (workosUserId: string) => string | null,
): WorkosUserDirectory => ({
  async getEmail(workosUserId) {
    return workosUserId ? resolve(workosUserId) : null;
  },
});

// Resolve a WorkOS organization's human-readable NAME from its `org_…` id.
//
// The org name lives only in WorkOS — our `tenants` rows store just the
// `workosOrganizationId`. The operator admin console shows the name beside the
// id, so it looks the name up server-side from the WorkOS organizations API.
//
// Like the user directory, lookups fail SOFT: any error / non-2xx returns null,
// so a WorkOS hiccup means the admin UI shows just the id rather than failing
// the whole tenant list.

export interface WorkosOrganizationDirectory {
  /** The org's display name, or null (unknown org / not configured / failed). */
  getName(workosOrganizationId: string): Promise<string | null>;
}

export const makeWorkosOrganizationDirectory = (
  apiKey: string,
  opts: { readonly baseUrl?: string; readonly fetchImpl?: FetchFn } = {},
): WorkosOrganizationDirectory => {
  const base = (opts.baseUrl ?? "https://api.workos.com").replace(/\/+$/u, "");
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async getName(workosOrganizationId) {
      if (!workosOrganizationId) return null;
      try {
        const res = await doFetch(
          `${base}/organizations/${encodeURIComponent(workosOrganizationId)}`,
          { headers: { authorization: `Bearer ${apiKey}` } },
        );
        if (!res.ok) return null;
        const body = (await res.json()) as { name?: unknown };
        return typeof body.name === "string" && body.name.length > 0
          ? body.name
          : null;
      } catch {
        return null;
      }
    },
  };
};

/** Test / injection directory backed by a plain resolver. */
export const makeStaticWorkosOrganizationDirectory = (
  resolve: (workosOrganizationId: string) => string | null,
): WorkosOrganizationDirectory => ({
  async getName(workosOrganizationId) {
    return workosOrganizationId ? resolve(workosOrganizationId) : null;
  },
});

// WRITE side of WorkOS: create an organization for a self-service signup, add
// the founder to it, resolve the user's existing memberships (so onboarding is
// idempotent — an invited user reuses their org), and send member/fulfillment-operator
// invitations. The Vite SPA (Option B) has no WORKOS_API_KEY, so these admin-SDK
// operations — which the Next dashboard ran in a server action — must run in the
// api. Raw fetch (no @workos-inc/node dep) keeps every call trivially testable
// via `fetchImpl`, matching the read directories above.
//
// Soft-fail like the read directories: a failed create/invite returns null and a
// failed membership returns false, so the caller decides (503 / retry / degrade)
// rather than the layer throwing.
export interface WorkosOrgAdminDirectory {
  /** Create an organization; returns its id, or null on failure. */
  createOrganization(name: string): Promise<{ readonly id: string } | null>;
  /** Add a user to an org; returns true on success, false on failure. */
  addOrganizationMembership(
    organizationId: string,
    workosUserId: string,
  ): Promise<boolean>;
  /**
   * The user's ACTIVE org membership ids (order preserved). `[]` means the user
   * genuinely belongs to no org; `null` means the LOOKUP failed — callers must
   * NOT treat a failed lookup as "no orgs" (that would provision a duplicate).
   */
  listOrganizationMemberships(
    workosUserId: string,
  ): Promise<ReadonlyArray<string> | null>;
  /** Send a WorkOS invitation; returns its id, or null on failure. */
  sendInvitation(input: {
    readonly email: string;
    readonly organizationId: string;
    readonly inviterUserId?: string;
  }): Promise<{ readonly id: string } | null>;
}

export const makeWorkosOrgAdminDirectory = (
  apiKey: string,
  opts: { readonly baseUrl?: string; readonly fetchImpl?: FetchFn } = {},
): WorkosOrgAdminDirectory => {
  const base = (opts.baseUrl ?? "https://api.workos.com").replace(/\/+$/u, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const authHeaders = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
  return {
    async createOrganization(name) {
      if (!name) return null;
      try {
        const res = await doFetch(`${base}/organizations`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ name }),
        });
        if (!res.ok) return null;
        const body = (await res.json()) as { id?: unknown };
        return typeof body.id === "string" && body.id.length > 0
          ? { id: body.id }
          : null;
      } catch {
        return null;
      }
    },
    async addOrganizationMembership(organizationId, workosUserId) {
      if (!organizationId || !workosUserId) return false;
      try {
        const res = await doFetch(
          `${base}/user_management/organization_memberships`,
          {
            method: "POST",
            headers: authHeaders,
            body: JSON.stringify({
              organization_id: organizationId,
              user_id: workosUserId,
            }),
          },
        );
        return res.ok;
      } catch {
        return false;
      }
    },
    async listOrganizationMemberships(workosUserId) {
      if (!workosUserId) return [];
      try {
        const res = await doFetch(
          `${base}/user_management/organization_memberships?user_id=${encodeURIComponent(
            workosUserId,
          )}&statuses=active`,
          { headers: authHeaders },
        );
        if (!res.ok) return null; // lookup failed — NOT "no orgs"
        const body = (await res.json()) as {
          data?: ReadonlyArray<{ organization_id?: unknown }>;
        };
        return (body.data ?? [])
          .map((m) => m.organization_id)
          .filter((id): id is string => typeof id === "string" && id.length > 0);
      } catch {
        return null; // lookup failed — NOT "no orgs"
      }
    },
    async sendInvitation({ email, organizationId, inviterUserId }) {
      if (!email || !organizationId) return null;
      try {
        const res = await doFetch(`${base}/user_management/invitations`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({
            email,
            organization_id: organizationId,
            ...(inviterUserId ? { inviter_user_id: inviterUserId } : {}),
          }),
        });
        if (!res.ok) return null;
        const body = (await res.json()) as { id?: unknown };
        return typeof body.id === "string" && body.id.length > 0
          ? { id: body.id }
          : null;
      } catch {
        return null;
      }
    },
  };
};

/** Test / injection admin directory backed by plain resolvers (safe defaults). */
export const makeStaticWorkosOrgAdminDirectory = (impl: {
  readonly createOrganization?: (name: string) => { readonly id: string } | null;
  readonly addOrganizationMembership?: (
    organizationId: string,
    workosUserId: string,
  ) => boolean;
  readonly listOrganizationMemberships?: (
    workosUserId: string,
  ) => ReadonlyArray<string> | null;
  readonly sendInvitation?: (input: {
    readonly email: string;
    readonly organizationId: string;
    readonly inviterUserId?: string;
  }) => { readonly id: string } | null;
}): WorkosOrgAdminDirectory => ({
  async createOrganization(name) {
    return impl.createOrganization?.(name) ?? { id: `org_${name}` };
  },
  async addOrganizationMembership(organizationId, workosUserId) {
    return impl.addOrganizationMembership?.(organizationId, workosUserId) ?? true;
  },
  async listOrganizationMemberships(workosUserId) {
    return impl.listOrganizationMemberships?.(workosUserId) ?? [];
  },
  async sendInvitation(input) {
    return (
      impl.sendInvitation?.(input) ?? { id: `invitation_${input.email}` }
    );
  },
});
