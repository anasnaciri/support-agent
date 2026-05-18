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
  /** Defaults to INBOX-only so we don't get notified on outbound sends. */
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
        labelIds: [...(opts.labelIds ?? ["INBOX"])],
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
