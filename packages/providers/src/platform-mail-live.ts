import { Context, Effect, Layer } from "effect";
import {
  PlatformMailSendFailed,
  PlatformMailService,
  PlatformMailUnconfigured,
  TenantRepository,
  type SendAccountDeletedInput,
  type SendApprovalLinkInput,
  type SendFulfillmentOperatorEscalationInput,
} from "@support-agent/services";

// ============================================================
// ResendConfig Tag
// ============================================================
//
// Kept distinct from `PlatformMailService` so the abstract Tag doesn't
// leak Resend-specific shape. When we add a second platform-mail
// provider (Postmark, SES), it gets its own Config Tag + its own Live
// Layer, both providing into `PlatformMailService`.

export class ResendConfig extends Context.Tag("ResendConfig")<
  ResendConfig,
  {
    /** Resend API key (`re_...`). */
    readonly apiKey: string;
    /** Verified sender address, e.g. `Support Agent <notifications@example.com>`. */
    readonly fromAddress: string;
    /** Override for tests; production uses global `fetch`. */
    readonly fetchImpl?: typeof fetch;
  }
>() {}

// ============================================================
// Resend Live layer for PlatformMailService
// ============================================================

const RESEND_ENDPOINT = "https://api.resend.com/emails";

const withoutEmDashes = (text: string): string =>
  text.replace(/\s*—\s*/gu, " - ");

const normalizeRenderedCopy = (rendered: {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}): {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
} => ({
  subject: withoutEmDashes(rendered.subject),
  text: withoutEmDashes(rendered.text),
  html: withoutEmDashes(rendered.html),
});

interface ResendErrorBody {
  readonly message?: string;
  readonly name?: string;
}

const safeJsonBody = async (
  res: Response,
): Promise<ResendErrorBody | string> => {
  const text = await res.text().catch(() => "");
  try {
    return JSON.parse(text) as ResendErrorBody;
  } catch {
    return text;
  }
};

const renderApprovalEmail = (input: SendApprovalLinkInput): {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
} => {
  const reminderPrefix = input.reminder ? "[REMINDER] " : "";
  const subject = `${reminderPrefix}${
    input.draftSubject
      ? `Approve reply: ${input.draftSubject}`
      : `Approve reply (${input.toolName})`
  }`;

  const lines = [
    ...(input.reminder ? ["[REMINDER]", ``] : []),
    `Your support agent drafted a reply that needs your approval.`,
    ``,
    `Tool: ${input.toolName}`,
    `Subject: ${input.draftSubject ?? "(thread default)"}`,
    ``,
    `Preview:`,
    input.draftPreview,
    ``,
    `Approve:  ${input.approveUrl}`,
    `Reject:   ${input.rejectUrl}`,
    ``,
    `These links are one-click and signed; opening them takes the action immediately. Approval links expire after a few days for safety.`,
  ];
  const text = lines.join("\n");

  // Minimal HTML — no template engine. Keep it readable in plain text
  // clients too. Use `<pre>` for the preview so newlines survive.
  const escape = (s: string): string =>
    s
      .replace(/&/gu, "&amp;")
      .replace(/</gu, "&lt;")
      .replace(/>/gu, "&gt;");
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5;color:#111">
  ${input.reminder ? "<p><strong>[REMINDER]</strong></p>" : ""}
  <p>Your support agent drafted a reply that needs your approval.</p>
  <p><strong>Tool:</strong> ${escape(input.toolName)}<br>
     <strong>Subject:</strong> ${escape(input.draftSubject ?? "(thread default)")}</p>
  <p><strong>Preview:</strong></p>
  <pre style="white-space:pre-wrap;background:#f6f6f6;padding:12px;border-radius:6px">${escape(input.draftPreview)}</pre>
  <p style="margin-top:24px">
    <a href="${escape(input.approveUrl)}" style="background:#16a34a;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;display:inline-block;margin-right:8px">Approve</a>
    <a href="${escape(input.rejectUrl)}" style="background:#dc2626;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;display:inline-block">Reject</a>
  </p>
  <p style="color:#666;font-size:12px;margin-top:24px">These links are one-click and signed; opening them takes the action immediately. Approval links expire after a few days for safety.</p>
</body></html>`;

  return { subject, text, html };
};

const renderAccountDeletedEmail = (input: SendAccountDeletedInput): {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
} => {
  const subject = `Your ${input.tenantName} account has been deleted`;
  const lines = [
    `Your ${input.tenantName} account on the support platform has been deleted.`,
    ``,
    `All associated data, including tickets, conversations, approvals, audit history, connected integrations, and your team's access, has been permanently removed. This cannot be undone.`,
    ``,
    `If you did not request this, contact support immediately.`,
  ];
  const text = lines.join("\n");
  const escape = (s: string): string =>
    s
      .replace(/&/gu, "&amp;")
      .replace(/</gu, "&lt;")
      .replace(/>/gu, "&gt;");
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5;color:#111">
  <p>Your <strong>${escape(input.tenantName)}</strong> account on the support platform has been deleted.</p>
  <p>All associated data, including tickets, conversations, approvals, audit history, connected integrations, and your team's access, has been permanently removed. This cannot be undone.</p>
  <p style="color:#666;font-size:12px;margin-top:24px">If you did not request this, contact support immediately.</p>
</body></html>`;
  return { subject, text, html };
};

export const renderFulfillmentOperatorEscalationEmail = (
  input: SendFulfillmentOperatorEscalationInput,
): {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
} => {
  const orderBit = input.orderRef ? ` (order ${input.orderRef})` : "";
  const subject = `Action needed: a ticket was escalated to you${orderBit}`;
  const escape = (s: string): string =>
    s
      .replace(/&/gu, "&amp;")
      .replace(/</gu, "&lt;")
      .replace(/>/gu, "&gt;");
  const cta = input.portalUrl
    ? `Open the ticket to respond: ${input.portalUrl}`
    : `Log in to your fulfillment partner portal to view and respond to this ticket.`;
  const text = [
    `A support ticket has been escalated to you${orderBit}.`,
    ``,
    `What's needed:`,
    input.problem,
    ``,
    cta,
  ].join("\n");
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5;color:#111">
  <p>A support ticket has been escalated to you${escape(orderBit)}.</p>
  <p><strong>What's needed:</strong></p>
  <pre style="white-space:pre-wrap;background:#f6f6f6;padding:12px;border-radius:6px">${escape(input.problem)}</pre>
  ${
    input.portalUrl
      ? `<p style="margin-top:24px"><a href="${escape(input.portalUrl)}" style="background:#0345fc;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;display:inline-block">Open the ticket</a></p>`
      : `<p style="margin-top:24px">Log in to your fulfillment partner portal to view and respond to this ticket.</p>`
  }
</body></html>`;
  return { subject, text, html };
};

export const PlatformMailServiceLive = Layer.effect(
  PlatformMailService,
  Effect.gen(function* () {
    const tenantRepo = yield* TenantRepository;
    const config = yield* ResendConfig;
    const fetchImpl = config.fetchImpl ?? fetch;

    // Shared Resend POST. Renders are passed in already-built so each
    // mail kind owns its template.
    // Shared Resend POST. `idempotencyKey`, when supplied, sets Resend's
    // `Idempotency-Key` header — Resend dedupes requests with the same key
    // within a ~24h window. pg-boss retries (and any duplicate cleanup job)
    // for one deletion happen far inside that window (retryLimit 5 with
    // backoff = minutes/hours), so in practice the deletion email is sent at
    // most once. NOTE: this is a 24h dedup, not an all-time guarantee — a
    // resurrected duplicate beyond 24h could resend (5th-audit #3, LOW).
    const post = (
      tenantId: SendAccountDeletedInput["tenantId"],
      recipient: string,
      rendered: { subject: string; text: string; html: string },
      idempotencyKey?: string,
    ): Effect.Effect<void, PlatformMailSendFailed> =>
      Effect.gen(function* () {
        const cleanRendered = normalizeRenderedCopy(rendered);
        const res = yield* Effect.tryPromise({
          try: () =>
            fetchImpl(RESEND_ENDPOINT, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${config.apiKey}`,
                "Content-Type": "application/json",
                ...(idempotencyKey
                  ? { "Idempotency-Key": idempotencyKey }
                  : {}),
              },
              body: JSON.stringify({
                from: config.fromAddress,
                to: [recipient],
                subject: cleanRendered.subject,
                text: cleanRendered.text,
                html: cleanRendered.html,
              }),
            }),
          catch: (cause) =>
            new PlatformMailSendFailed({ tenantId, cause }),
        });
        if (!res.ok) {
          const body = yield* Effect.promise(() => safeJsonBody(res));
          return yield* Effect.fail(
            new PlatformMailSendFailed({
              tenantId,
              cause: { status: res.status, body },
            }),
          );
        }
      });

    return PlatformMailService.of({
      // The fulfillment operator (external) is addressed directly; no tenant lookup.
      // Keep the historical Resend wire key permanently: Resend owns that
      // idempotency namespace, and changing it during the domain migration can
      // double-mail an escalation that sent just before its DB stamp failed.
      sendFulfillmentOperatorEscalation: (input) =>
        post(
          input.tenantId,
          input.fulfillmentOperatorEmail,
          renderFulfillmentOperatorEscalationEmail(input),
          `supplier-escalation:${input.escalationId}`,
        ),
      sendAccountDeleted: (input) =>
        post(
          input.tenantId,
          input.recipientEmail,
          renderAccountDeletedEmail(input),
          // Stable per-tenant key → Resend dedupes the deletion email across
          // this deletion's retries / duplicate jobs (within its 24h window).
          `account-deleted:${input.tenantId}`,
        ),
      // Audit L5: a dead connector (lapsed Graph subscription, revoked
      // refresh token) silently stops inbound customer mail — alert the
      // operator. Recipient resolved like the approval email; tenants
      // without a notificationEmail surface PlatformMailUnconfigured and
      // the caller degrades to the health flag alone.
      sendConnectorAlert: (input) =>
        Effect.gen(function* () {
          const settings = yield* tenantRepo.getSettings(input.tenantId).pipe(
            Effect.mapError(
              (cause) =>
                new PlatformMailSendFailed({
                  tenantId: input.tenantId,
                  cause,
                }),
            ),
          );
          const recipient = settings.notificationEmail;
          if (!recipient) {
            return yield* Effect.fail(
              new PlatformMailUnconfigured({ tenantId: input.tenantId }),
            );
          }
          const subject = `[support-agent] ${input.provider} connection needs attention`;
          const text = [
            `Your ${input.provider} connection (${input.mailbox}) has stopped working:`,
            "",
            `  ${input.reason}`,
            "",
            "Inbound customer email is NOT being received until it is reconnected.",
            "Open your dashboard → Settings → Integrations and reconnect the mailbox.",
          ].join("\n");
          yield* post(
            input.tenantId,
            recipient,
            {
              subject,
              text,
              html: `<p>Your <strong>${input.provider}</strong> connection (${input.mailbox}) has stopped working:</p><p><code>${input.reason}</code></p><p><strong>Inbound customer email is NOT being received until it is reconnected.</strong></p><p>Open your dashboard → Settings → Integrations and reconnect the mailbox.</p>`,
            },
            // One alert per connector per day even across cron retries.
            `connector-alert:${input.tenantId}:${input.provider}:${input.mailbox}`,
          );
        }),
      // Email channel of a merchant heads-up. Recipient resolved like the
      // approval/connector mail; no notificationEmail → PlatformMailUnconfigured
      // (the multi-channel notifier degrades to its other channels). No
      // idempotency key — pings are intentionally one-shot, not retried.
      sendMerchantNotification: (input) =>
        Effect.gen(function* () {
          const settings = yield* tenantRepo.getSettings(input.tenantId).pipe(
            Effect.mapError(
              (cause) =>
                new PlatformMailSendFailed({
                  tenantId: input.tenantId,
                  cause,
                }),
            ),
          );
          const recipient = settings.notificationEmail;
          if (!recipient) {
            return yield* Effect.fail(
              new PlatformMailUnconfigured({ tenantId: input.tenantId }),
            );
          }
          const ref = input.ticketId ? ` (ticket ${input.ticketId})` : "";
          const subject = `[support-agent] ${input.title}`;
          const text = `${input.body}${ref}`;
          const html = `<p>${input.body}</p>${
            input.ticketId
              ? `<p style="color:#666">Ticket reference: ${input.ticketId}</p>`
              : ""
          }`;
          yield* post(input.tenantId, recipient, { subject, text, html });
        }),
      sendApprovalLink: (input) =>
        Effect.gen(function* () {
          // 1. Resolve recipient via the TenantRepository Tag (db Live impl
          //    reads tenants.settings.notificationEmail). Keeps providers
          //    free of any direct Postgres dependency.
          const settings = yield* tenantRepo.getSettings(input.tenantId).pipe(
            Effect.mapError(
              (cause) =>
                new PlatformMailSendFailed({
                  tenantId: input.tenantId,
                  cause,
                }),
            ),
          );
          const recipient = settings.notificationEmail;
          if (!recipient) {
            return yield* Effect.fail(
              new PlatformMailUnconfigured({ tenantId: input.tenantId }),
            );
          }

          // 2. Render + POST to Resend.
          const { subject, text, html } = renderApprovalEmail(input);
          const cleanRendered = normalizeRenderedCopy({ subject, text, html });
          const res = yield* Effect.tryPromise({
            try: () =>
              fetchImpl(RESEND_ENDPOINT, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${config.apiKey}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  from: config.fromAddress,
                  to: [recipient],
                  subject: cleanRendered.subject,
                  text: cleanRendered.text,
                  html: cleanRendered.html,
                }),
              }),
            catch: (cause) =>
              new PlatformMailSendFailed({
                tenantId: input.tenantId,
                cause,
              }),
          });

          if (!res.ok) {
            const body = yield* Effect.promise(() => safeJsonBody(res));
            return yield* Effect.fail(
              new PlatformMailSendFailed({
                tenantId: input.tenantId,
                cause: { status: res.status, body },
              }),
            );
          }
        }),
    });
  }),
);

// ============================================================
// Env-driven config helper
// ============================================================
//
// Reads RESEND_API_KEY + RESEND_FROM. Fails Layer build if either is
// missing so we don't silently no-op on misconfigured production.

export const ResendConfigFromEnv = Layer.effect(
  ResendConfig,
  Effect.sync(() => {
    const apiKey = process.env["RESEND_API_KEY"];
    const fromAddress = process.env["RESEND_FROM_ADDRESS"];
    if (!apiKey) throw new Error("RESEND_API_KEY is required");
    if (!fromAddress) throw new Error("RESEND_FROM_ADDRESS is required");
    return { apiKey, fromAddress };
  }),
);
