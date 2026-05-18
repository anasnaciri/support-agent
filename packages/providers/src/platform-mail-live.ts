import { Context, Effect, Layer } from "effect";
import {
  PlatformMailSendFailed,
  PlatformMailService,
  PlatformMailUnconfigured,
  TenantRepository,
  type SendApprovalLinkInput,
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
  const subject = input.draftSubject
    ? `Approve reply: ${input.draftSubject}`
    : `Approve reply (${input.toolName})`;

  const lines = [
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

export const PlatformMailServiceLive = Layer.effect(
  PlatformMailService,
  Effect.gen(function* () {
    const tenantRepo = yield* TenantRepository;
    const config = yield* ResendConfig;
    const fetchImpl = config.fetchImpl ?? fetch;

    return PlatformMailService.of({
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
                  subject,
                  text,
                  html,
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
