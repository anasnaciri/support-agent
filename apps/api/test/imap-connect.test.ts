import { describe, expect, it } from "vitest";
import {
  imapConnectionMetadata,
  parseImapConnectBody,
} from "../src/imap-connect.js";

describe("parseImapConnectBody", () => {
  it("builds a config from a complete body, defaulting login user to the mailbox", () => {
    const parsed = parseImapConnectBody({
      mailbox: "support@merchant.com",
      password: "app-pass",
      imapHost: "imap.privateemail.com",
      smtpHost: "smtp.privateemail.com",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.mailbox).toBe("support@merchant.com");
    expect(parsed.value.config).toMatchObject({
      imapHost: "imap.privateemail.com",
      imapPort: 993,
      imapSecure: true,
      smtpHost: "smtp.privateemail.com",
      smtpPort: 465,
      smtpSecure: true,
      user: "support@merchant.com",
      password: "app-pass",
    });
  });

  it("defaults smtpSecure to false for STARTTLS port 587", () => {
    const parsed = parseImapConnectBody({
      mailbox: "a@b.com",
      password: "p",
      imapHost: "imap.b.com",
      smtpHost: "smtp.b.com",
      smtpPort: 587,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.config.smtpPort).toBe(587);
    expect(parsed.value.config.smtpSecure).toBe(false);
  });

  it("accepts string ports and an explicit login user", () => {
    const parsed = parseImapConnectBody({
      mailbox: "a@b.com",
      user: "login@b.com",
      password: "p",
      imapHost: "imap.b.com",
      imapPort: "143",
      imapSecure: false,
      smtpHost: "smtp.b.com",
      smtpPort: "2525",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.config.imapPort).toBe(143);
    expect(parsed.value.config.imapSecure).toBe(false);
    expect(parsed.value.config.smtpPort).toBe(2525);
    expect(parsed.value.config.user).toBe("login@b.com");
  });

  it.each([
    [{ password: "p", imapHost: "i", smtpHost: "s" }, "missing_mailbox"],
    [{ mailbox: "a@b.com", imapHost: "i", smtpHost: "s" }, "missing_password"],
    [{ mailbox: "a@b.com", password: "p", smtpHost: "s" }, "missing_imap_host"],
    [{ mailbox: "a@b.com", password: "p", imapHost: "i" }, "missing_smtp_host"],
  ])("rejects an incomplete body (%#)", (body, error) => {
    const parsed = parseImapConnectBody(body as Record<string, unknown>);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toBe(error);
  });

  it("metadata excludes the password", () => {
    const meta = imapConnectionMetadata({
      imapHost: "i",
      imapPort: 993,
      imapSecure: true,
      smtpHost: "s",
      smtpPort: 465,
      smtpSecure: true,
      user: "u@b.com",
      password: "secret",
    });
    expect(meta).not.toHaveProperty("password");
    expect(meta["imapHost"]).toBe("i");
    expect(meta["user"]).toBe("u@b.com");
  });
});
