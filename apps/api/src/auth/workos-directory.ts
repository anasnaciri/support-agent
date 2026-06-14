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
