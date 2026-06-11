import { describe, expect, it } from "vitest";
import { parseImapConnectBody } from "../src/imap-connect.js";

// S7 — TLS is mandatory for the IMAP/SMTP connector: `secure: false` means
// required STARTTLS, never cleartext. A body that explicitly opts out of TLS
// is refused at parse time with the existing-style validation error so the
// dashboard form can surface it.

describe("parseImapConnectBody TLS policy", () => {
  const base = {
    mailbox: "a@b.com",
    password: "p",
    imapHost: "imap.b.com",
    smtpHost: "smtp.b.com",
  };

  it.each([
    ["requireTLS: false", { requireTLS: false }],
    ["ignoreTLS: true", { ignoreTLS: true }],
    ["doSTARTTLS: false", { doSTARTTLS: false }],
    ["starttls: false", { starttls: false }],
    ["tls: false", { tls: false }],
  ])("refuses a body that opts out of TLS (%s)", (_label, extra) => {
    const parsed = parseImapConnectBody({ ...base, ...extra });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toBe("tls_required");
  });

  it("still accepts secure:false ports — that is mandatory STARTTLS, not cleartext", () => {
    const parsed = parseImapConnectBody({
      ...base,
      imapPort: 143,
      imapSecure: false,
      smtpPort: 587,
      smtpSecure: false,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.config.imapSecure).toBe(false);
    expect(parsed.value.config.smtpSecure).toBe(false);
  });
});
