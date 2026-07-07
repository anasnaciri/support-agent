// ============================================================
// Gmail `users.watch` — Pub/Sub subscription lifecycle
// ============================================================
//
// `users.watch` is a polled-resource subscription: each call sets a ~7-day
// lease that publishes a notification to the configured Pub/Sub topic
// every time the mailbox changes. We register one at install time and
// renew via a worker-side cron (apps/worker/src/gmail-watch-renewal.ts)
// at T-1 day before lease expiry.
//
// Lives in `packages/providers` (not `apps/api`) because both the API
// install callback AND the worker renewal job call it.

export interface StartGmailWatchOptions {
  readonly accessToken: string;
  readonly topicName: string;
  /**
   * Defaults to INBOX + SPAM: customer mail is ingested even when Gmail
   * spam-filters it, while outbound sends (SENT) still don't notify us.
   */
  readonly labelIds?: ReadonlyArray<string>;
  readonly fetchImpl?: typeof fetch;
}

export interface GmailWatchResult {
  /** `historyId` to use as `startHistoryId` on the next history.list. */
  readonly historyId: string;
  /** Unix-ms expiry — surfaced so callers can persist the lease end. */
  readonly expiresAt: Date;
}

interface RawWatchJson {
  readonly historyId?: string;
  readonly expiration?: string;
  readonly error?: { readonly message?: string };
}

export const startGmailWatch = async (
  opts: StartGmailWatchOptions,
): Promise<GmailWatchResult> => {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(
    "https://gmail.googleapis.com/gmail/v1/users/me/watch",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        topicName: opts.topicName,
        labelIds: [...(opts.labelIds ?? ["INBOX", "SPAM"])],
        labelFilterBehavior: "INCLUDE",
      }),
    },
  );
  const json = (await res.json()) as RawWatchJson;
  if (!res.ok || !json.historyId || !json.expiration) {
    throw new Error(
      `users.watch failed: ${res.status} ${json.error?.message ?? "unknown"}`,
    );
  }
  return {
    historyId: json.historyId,
    expiresAt: new Date(Number(json.expiration)),
  };
};

/**
 * Stop the Pub/Sub watch on a mailbox (`users.stop`). Used when a tenant
 * disconnects Gmail or deletes their account — without this the lease keeps
 * publishing change notifications until it expires (~7 days). Best-effort:
 * returns `false` instead of throwing so a cleanup flow isn't blocked by a
 * dead token. A 404 (no active watch) is treated as success.
 */
export const stopGmailWatch = async (
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> => {
  try {
    const res = await fetchImpl(
      "https://gmail.googleapis.com/gmail/v1/users/me/stop",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
};
