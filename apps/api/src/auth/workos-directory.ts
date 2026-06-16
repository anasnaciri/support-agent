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
