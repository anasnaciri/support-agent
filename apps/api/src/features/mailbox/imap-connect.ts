// ============================================================
// IMAP/SMTP connect — request parsing (pure, testable)
// ============================================================
//
// The generic IMAP/SMTP connector has no OAuth flow: the merchant submits
// host/port/security + an app password through a dashboard form, which the
// API validates, connectivity-checks, and stores. This module is the pure
// parse/validate half so the handler in `server.ts` stays thin.

import type { ImapSmtpConfig } from "@support-agent/providers";

export interface ImapConnectInput {
  readonly config: ImapSmtpConfig;
  /** Mailbox address — the `shopDomain` discriminator on the connection. */
  readonly mailbox: string;
}

export type ImapConnectParse =
  | { readonly ok: true; readonly value: ImapConnectInput }
  | { readonly ok: false; readonly error: string };

const asString = (v: unknown): string | null =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : null;

const asPort = (v: unknown, fallback: number): number => {
  if (typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 65535) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isInteger(n) && n > 0 && n <= 65535) return n;
  }
  return fallback;
};

const asBool = (v: unknown, fallback: boolean): boolean =>
  typeof v === "boolean" ? v : fallback;

// TLS is mandatory (S7): `secure: false` means *required* STARTTLS — the
// transport layer (`makeImapSmtpOps`) aborts pre-auth when the server can't
// upgrade. A body that explicitly asks to skip TLS entirely is refused here
// so the dashboard form surfaces the misconfiguration instead of the fields
// being silently ignored.
const requestsCleartext = (body: Record<string, unknown>): boolean =>
  body["requireTLS"] === false ||
  body["doSTARTTLS"] === false ||
  body["starttls"] === false ||
  body["tls"] === false ||
  body["ignoreTLS"] === true;

export const parseImapConnectBody = (
  body: Record<string, unknown>,
): ImapConnectParse => {
  if (requestsCleartext(body)) return { ok: false, error: "tls_required" };
  const mailbox = asString(body["mailbox"]) ?? asString(body["user"]);
  const password = asString(body["password"]);
  const imapHost = asString(body["imapHost"]);
  const smtpHost = asString(body["smtpHost"]);
  if (!mailbox) return { ok: false, error: "missing_mailbox" };
  if (!password) return { ok: false, error: "missing_password" };
  if (!imapHost) return { ok: false, error: "missing_imap_host" };
  if (!smtpHost) return { ok: false, error: "missing_smtp_host" };
  const smtpPort = asPort(body["smtpPort"], 465);
  return {
    ok: true,
    value: {
      mailbox,
      config: {
        imapHost,
        imapPort: asPort(body["imapPort"], 993),
        imapSecure: asBool(body["imapSecure"], true),
        smtpHost,
        smtpPort,
        // Implicit TLS on 465; STARTTLS (secure:false) on 587/others unless
        // the caller says otherwise.
        smtpSecure: asBool(body["smtpSecure"], smtpPort === 465),
        user: asString(body["user"]) ?? mailbox,
        password,
      },
    },
  };
};

/** Metadata persisted on the connection (everything but the password). */
export const imapConnectionMetadata = (
  config: ImapSmtpConfig,
): Readonly<Record<string, unknown>> => ({
  imapHost: config.imapHost,
  imapPort: config.imapPort,
  imapSecure: config.imapSecure,
  smtpHost: config.smtpHost,
  smtpPort: config.smtpPort,
  smtpSecure: config.smtpSecure,
  user: config.user,
});
