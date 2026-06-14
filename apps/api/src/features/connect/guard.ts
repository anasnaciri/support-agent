// ============================================================
// One conversation mailbox per provider per store
// ============================================================
//
// The same invariant the IMAP connect endpoint enforces, for the OAuth
// connectors: replies resolve credentials per (tenant, provider), so a
// second active mailbox on the same provider could send from the wrong
// account. Connecting a different account requires disconnecting first;
// re-authorizing the SAME mailbox stays allowed (token repair upserts the
// row in place).
//
// Pure helpers — the handlers in `server.ts` supply the tenant's
// connection list and act on the verdict.

import type { ConnectorConnection } from "@support-agent/services";

/** OAuth-connected conversation mailbox providers. */
export type OAuthMailboxProvider = "gmail" | "outlook";

/**
 * The active connection that blocks a new connect, or `null` when the
 * connect may proceed. Omit `mailbox` when the account isn't known yet
 * (pre-OAuth install grant): ANY active row for the provider conflicts.
 * With `mailbox` (the OAuth callback knows the chosen account), only a
 * DIFFERENT address conflicts — same-address re-auth is a repair flow.
 */
export const activeMailboxConflict = (
  connections: ReadonlyArray<ConnectorConnection>,
  provider: OAuthMailboxProvider,
  mailbox?: string,
): ConnectorConnection | null =>
  connections.find(
    (c) =>
      c.provider === provider &&
      c.status === "active" &&
      (mailbox === undefined ||
        c.shopDomain.toLowerCase() !== mailbox.toLowerCase()),
  ) ?? null;

/**
 * Browser-facing rejection target: the integrations page with the
 * conflict spelled out. Mirrors `dashboardConnectRedirect`'s URL-join
 * rules (string-join so a path-prefixed base survives). `null` when no
 * dashboard base URL is configured — callers fall back to JSON.
 */
export const alreadyConnectedRedirect = (
  dashboardBaseUrl: string | null,
  provider: OAuthMailboxProvider,
  mailbox: string,
): string | null => {
  if (!dashboardBaseUrl) return null;
  const trimmed = dashboardBaseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  try {
    const url = new URL(`${trimmed}/settings/integrations`);
    url.searchParams.set("error", "already_connected");
    url.searchParams.set("provider", provider);
    url.searchParams.set("mailbox", mailbox);
    return url.toString();
  } catch {
    return null;
  }
};
