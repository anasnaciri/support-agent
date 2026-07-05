/**
 * Per-tenant blocked senders — pure normalize / validate / match helpers.
 *
 * Stored as a `blockedSenders` sub-object of `tenants.settings` (JSONB):
 * `{ emails: string[], domains: string[] }`, all values normalized
 * (trimmed, lowercased). Email entries match one exact address; domain
 * entries match the domain and every subdomain of it.
 *
 * Shared by the agent runtime (drop inbound mail before any ticket work)
 * and the dashboard API handlers (validate list edits), so it lives in its
 * own module rather than agent-runtime-helpers.
 */

export interface BlockedSenders {
  readonly emails: ReadonlyArray<string>;
  readonly domains: ReadonlyArray<string>;
}

export const defaultBlockedSenders: BlockedSenders = {
  emails: [],
  domains: [],
};

/** Per-list cap, enforced on write by the dashboard API. */
export const BLOCKED_SENDERS_MAX = 500;

/**
 * RFC-ish hostname: dot-separated labels, alphanumeric with inner hyphens,
 * ending in an alphabetic TLD. Requires at least one dot so bare words
 * ("com", "localhost") aren't accepted as block-the-internet entries.
 */
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

const normalizeDomain = (raw: string): string | null => {
  const v = raw.replace(/\.$/, "");
  if (v.length === 0 || v.length > 253 || !DOMAIN_RE.test(v)) return null;
  return v;
};

export interface BlockedSenderEntry {
  readonly kind: "email" | "domain";
  readonly value: string;
}

/**
 * Normalize + classify a user-supplied blocklist entry.
 *
 * `user@spam.com` → email entry; `spam.com` / `@spam.com` → domain entry;
 * anything that isn't a plausible address or hostname → null (caller
 * rejects with a validation error).
 */
export const normalizeBlockedSenderInput = (
  raw: string,
): BlockedSenderEntry | null => {
  const v = raw.trim().toLowerCase();
  if (v === "") return null;
  if (v.startsWith("@")) {
    const domain = normalizeDomain(v.slice(1));
    return domain ? { kind: "domain", value: domain } : null;
  }
  if (v.includes("@")) {
    if (v.length > 320) return null;
    const at = v.indexOf("@");
    if (v.indexOf("@", at + 1) !== -1) return null;
    const local = v.slice(0, at);
    if (local === "") return null;
    const domain = normalizeDomain(v.slice(at + 1));
    return domain ? { kind: "email", value: `${local}@${domain}` } : null;
  }
  const domain = normalizeDomain(v);
  return domain ? { kind: "domain", value: domain } : null;
};

const domainOf = (email: string): string | null => {
  const at = email.lastIndexOf("@");
  return at === -1 ? null : email.slice(at + 1);
};

/**
 * True when any candidate sender address is blocked. Candidates are the
 * inbound message's From and Reply-To addresses (checking both means a
 * blocked domain can't be dodged via an innocuous Reply-To). Nullish
 * candidates are ignored; matching is case-insensitive. Domain entries
 * match on label boundaries: `spam.co` blocks `x@spam.co` and
 * `x@em1.spam.co` but not `x@notspam.co`.
 */
export const isBlockedSender = (
  blocked: BlockedSenders,
  candidates: ReadonlyArray<string | null | undefined>,
): boolean => {
  if (blocked.emails.length === 0 && blocked.domains.length === 0) {
    return false;
  }
  for (const raw of candidates) {
    if (typeof raw !== "string") continue;
    const email = raw.trim().toLowerCase();
    if (email === "") continue;
    if (blocked.emails.includes(email)) return true;
    const domain = domainOf(email);
    if (
      domain &&
      blocked.domains.some((d) => domain === d || domain.endsWith(`.${d}`))
    ) {
      return true;
    }
  }
  return false;
};

const decodeList = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.filter(
        (v): v is string => typeof v === "string" && v.trim() !== "",
      )
    : [];

/**
 * Defaults-on-read decode of the `blockedSenders` settings sub-object.
 * Never throws: missing key, wrong shapes, or non-string entries collapse
 * to empty lists so a corrupt settings row can't take down ingestion.
 */
export const decodeBlockedSenders = (value: unknown): BlockedSenders => {
  if (typeof value !== "object" || value === null) {
    return defaultBlockedSenders;
  }
  const v = value as { emails?: unknown; domains?: unknown };
  return {
    emails: decodeList(v.emails),
    domains: decodeList(v.domains),
  };
};
