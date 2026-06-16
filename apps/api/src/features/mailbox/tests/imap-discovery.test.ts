import { describe, expect, it, vi } from "vitest";
import {
  appPasswordUrlFor,
  discoverImapSettings,
  ispdbUrl,
  mailDomainFromEmail,
  oauthProviderForDomain,
  oauthProviderForMxHost,
  parseIspdbXml,
  presetForMxHost,
  registrableDomain,
  type DiscoveryIo,
} from "../imap-discovery.js";

// ============================================================
// mailDomainFromEmail
// ============================================================

describe("mailDomainFromEmail", () => {
  it("lowercases and extracts the domain", () => {
    expect(mailDomainFromEmail("Support@MyStore.COM")).toBe("mystore.com");
  });

  it("rejects non-emails and unsafe domains", () => {
    expect(mailDomainFromEmail("not-an-email")).toBeNull();
    expect(mailDomainFromEmail("a@b@c.com")).toBeNull();
    expect(mailDomainFromEmail("a@no-dot")).toBeNull();
    expect(mailDomainFromEmail("a@-bad.com")).toBeNull();
    expect(mailDomainFromEmail("a@bad-.com")).toBeNull();
    expect(mailDomainFromEmail("a@exa mple.com")).toBeNull();
    expect(mailDomainFromEmail("a@exa/mple.com")).toBeNull();
    expect(mailDomainFromEmail("a@.leading.com")).toBeNull();
    expect(mailDomainFromEmail("a@trailing.com.")).toBeNull();
    expect(mailDomainFromEmail("")).toBeNull();
  });
});

// ============================================================
// OAuth-provider detection (these merchants should not be here)
// ============================================================

describe("oauthProviderForDomain", () => {
  it("maps consumer Google/Microsoft domains to their OAuth connectors", () => {
    expect(oauthProviderForDomain("gmail.com")).toBe("google");
    expect(oauthProviderForDomain("googlemail.com")).toBe("google");
    expect(oauthProviderForDomain("outlook.com")).toBe("outlook");
    expect(oauthProviderForDomain("hotmail.com")).toBe("outlook");
    expect(oauthProviderForDomain("live.com")).toBe("outlook");
    expect(oauthProviderForDomain("msn.com")).toBe("outlook");
  });

  it("leaves everything else alone", () => {
    expect(oauthProviderForDomain("zoho.com")).toBeNull();
    expect(oauthProviderForDomain("mystore.com")).toBeNull();
  });
});

describe("oauthProviderForMxHost", () => {
  it("detects Google Workspace and Microsoft 365 custom domains by MX suffix", () => {
    expect(oauthProviderForMxHost("aspmx.l.google.com")).toBe("google");
    expect(oauthProviderForMxHost("ASPMX.L.GOOGLE.COM")).toBe("google");
    expect(
      oauthProviderForMxHost("mystore-com.mail.protection.outlook.com"),
    ).toBe("outlook");
    expect(
      oauthProviderForMxHost("example.olc.protection.outlook.com"),
    ).toBe("outlook");
  });

  it("does not match other hosts (including lookalike suffixes)", () => {
    expect(oauthProviderForMxHost("mx.zoho.com")).toBeNull();
    expect(oauthProviderForMxHost("notgoogle.com")).toBeNull();
    expect(oauthProviderForMxHost("evilgoogle.com")).toBeNull();
  });
});

// ============================================================
// ISPDB XML parsing
// ============================================================

const ZOHO_XML = `<?xml version="1.0"?>
<clientConfig version="1.1">
  <emailProvider id="zoho.com">
    <domain>zoho.com</domain>
    <displayName>Zoho Mail</displayName>
    <displayShortName>Zoho</displayShortName>
    <incomingServer type="pop3">
      <hostname>pop.zoho.com</hostname>
      <port>995</port>
      <socketType>SSL</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </incomingServer>
    <incomingServer type="imap">
      <hostname>imap.zoho.com</hostname>
      <port>993</port>
      <socketType>SSL</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>smtp.zoho.com</hostname>
      <port>465</port>
      <socketType>SSL</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </outgoingServer>
  </emailProvider>
</clientConfig>`;

const STARTTLS_LOCALPART_XML = `<?xml version="1.0"?>
<clientConfig version="1.1">
  <emailProvider id="example.net">
    <domain>example.net</domain>
    <displayName>Example Mail</displayName>
    <incomingServer type="imap">
      <hostname>imap.example.net</hostname>
      <port>143</port>
      <socketType>STARTTLS</socketType>
      <username>%EMAILLOCALPART%</username>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>smtp.example.net</hostname>
      <port>587</port>
      <socketType>STARTTLS</socketType>
      <username>%EMAILLOCALPART%</username>
    </outgoingServer>
  </emailProvider>
</clientConfig>`;

describe("parseIspdbXml", () => {
  it("parses an SSL config, preferring the imap server over pop3", () => {
    const parsed = parseIspdbXml(ZOHO_XML, "support@mystore.com");
    expect(parsed).toEqual({
      providerId: "zoho.com",
      providerName: "Zoho Mail",
      settings: {
        imapHost: "imap.zoho.com",
        imapPort: 993,
        imapSecure: true,
        smtpHost: "smtp.zoho.com",
        smtpPort: 465,
        smtpSecure: true,
        // %EMAILADDRESS% resolves to the mailbox itself = the connect
        // endpoint's default, so no explicit username is needed.
        username: null,
      },
    });
  });

  it("parses STARTTLS configs and resolves %EMAILLOCALPART% usernames", () => {
    const parsed = parseIspdbXml(STARTTLS_LOCALPART_XML, "support@mystore.com");
    expect(parsed).not.toBeNull();
    expect(parsed?.settings).toMatchObject({
      imapPort: 143,
      imapSecure: false,
      smtpPort: 587,
      smtpSecure: false,
      username: "support",
    });
  });

  it("returns null for garbage, missing imap, or missing smtp", () => {
    expect(parseIspdbXml("<html>404</html>", "a@b.com")).toBeNull();
    expect(parseIspdbXml("", "a@b.com")).toBeNull();
    const noSmtp = ZOHO_XML.replace(/<outgoingServer[\s\S]*?<\/outgoingServer>/, "");
    expect(parseIspdbXml(noSmtp, "a@b.com")).toBeNull();
  });

  it("rejects hostnames that resolve to unsafe values", () => {
    const evil = ZOHO_XML.replace("imap.zoho.com", "im ap.zoho.com");
    expect(parseIspdbXml(evil, "a@b.com")).toBeNull();
  });
});

// ============================================================
// MX-suffix presets + registrable domain
// ============================================================

describe("presetForMxHost", () => {
  it("maps Namecheap PrivateEmail MX hosts", () => {
    const preset = presetForMxHost("mx1.privateemail.com");
    expect(preset).not.toBeNull();
    expect(preset?.settings).toMatchObject({
      imapHost: "mail.privateemail.com",
      imapPort: 993,
      smtpHost: "mail.privateemail.com",
      smtpPort: 465,
    });
    expect(preset?.providerName).toBe("Namecheap Private Email");
  });

  it("maps Zoho per-region MX hosts to per-region servers", () => {
    expect(presetForMxHost("mx.zoho.com")?.settings.imapHost).toBe(
      "imap.zoho.com",
    );
    expect(presetForMxHost("mx.zoho.eu")?.settings.imapHost).toBe(
      "imap.zoho.eu",
    );
  });

  it("maps Fastmail's messagingengine MX hosts", () => {
    expect(presetForMxHost("in1-smtp.messagingengine.com")?.settings).toMatchObject(
      { imapHost: "imap.fastmail.com", smtpHost: "smtp.fastmail.com" },
    );
  });

  it("returns null for unknown hosts", () => {
    expect(presetForMxHost("mx1.totally-unknown.example")).toBeNull();
  });

  // Namecheap IMAP/SMTP signs in with the *normal* mailbox password; an
  // app-specific password is only needed once 2FA is on (and the app-password
  // picker there has no plain "IMAP" entry). Flag it so the form stops telling
  // merchants they must create an app password.
  it("flags Namecheap as normal-password with a 2FA app-password fallback", () => {
    const preset = presetForMxHost("mx1.privateemail.com");
    expect(preset?.passwordHint).toBe("app_password_if_2fa");
    expect(preset?.appPasswordUrl).toContain("namecheap");
  });

  it("flags Zoho and Fastmail as app-password providers", () => {
    expect(presetForMxHost("mx.zoho.com")?.passwordHint).toBe("app_password");
    expect(
      presetForMxHost("in1-smtp.messagingengine.com")?.passwordHint,
    ).toBe("app_password");
  });

  it("flags plain mailbox-password hosts as regular", () => {
    expect(presetForMxHost("mailstore1.secureserver.net")?.passwordHint).toBe(
      "regular",
    );
  });
});

describe("registrableDomain", () => {
  it("takes the last two labels", () => {
    expect(registrableDomain("mx1.privateemail.com")).toBe("privateemail.com");
    expect(registrableDomain("a.b.c.example.net")).toBe("example.net");
    expect(registrableDomain("example.com")).toBe("example.com");
  });

  it("returns null for single labels", () => {
    expect(registrableDomain("localhost")).toBeNull();
  });
});

describe("appPasswordUrlFor", () => {
  it("knows the big app-password providers", () => {
    expect(appPasswordUrlFor("zoho.com")).toContain("zoho");
    expect(appPasswordUrlFor("fastmail.com")).toContain("fastmail");
  });

  it("returns null for unknown providers", () => {
    expect(appPasswordUrlFor("mystery.example")).toBeNull();
  });
});

// ============================================================
// Orchestration — discoverImapSettings
// ============================================================

const NO_IO: DiscoveryIo = {
  fetchText: async () => null,
  resolveMx: async () => [],
  hostExists: async () => false,
};

describe("discoverImapSettings", () => {
  it("returns unknown for an unparseable email without touching the network", async () => {
    const fetchText = vi.fn(NO_IO.fetchText);
    const result = await discoverImapSettings("nope", { ...NO_IO, fetchText });
    expect(result).toEqual({ kind: "unknown" });
    expect(fetchText).not.toHaveBeenCalled();
  });

  it("short-circuits gmail addresses to the google OAuth connector", async () => {
    const fetchText = vi.fn(NO_IO.fetchText);
    const result = await discoverImapSettings("shop@gmail.com", {
      ...NO_IO,
      fetchText,
    });
    expect(result).toEqual({ kind: "oauth", provider: "google" });
    expect(fetchText).not.toHaveBeenCalled();
  });

  it("uses an ISPDB hit for the email domain (source: ispdb)", async () => {
    const fetchText = vi.fn(async (url: string) =>
      url === ispdbUrl("zoho.com") ? ZOHO_XML : null,
    );
    const result = await discoverImapSettings("shop@zoho.com", {
      ...NO_IO,
      fetchText,
    });
    expect(result).toMatchObject({
      kind: "settings",
      source: "ispdb",
      providerName: "Zoho Mail",
      settings: { imapHost: "imap.zoho.com", smtpHost: "smtp.zoho.com" },
    });
    expect(
      result.kind === "settings" ? result.appPasswordUrl : null,
    ).toContain("zoho");
    expect(
      result.kind === "settings" ? result.passwordHint : null,
    ).toBe("app_password");
  });

  it("marks ISPDB providers with no known app-password page as regular", async () => {
    const result = await discoverImapSettings("shop@examplemail.net", {
      ...NO_IO,
      fetchText: async (url: string) =>
        url === ispdbUrl("examplemail.net") ? STARTTLS_LOCALPART_XML : null,
    });
    expect(result).toMatchObject({
      kind: "settings",
      passwordHint: "regular",
    });
  });

  it("detects Google Workspace custom domains via MX and points at OAuth", async () => {
    const result = await discoverImapSettings("support@mystore.com", {
      ...NO_IO,
      // Out-of-order priorities: the primary (10) is google.
      resolveMx: async () => [
        { exchange: "backup.example.org", priority: 20 },
        { exchange: "aspmx.l.google.com", priority: 10 },
      ],
    });
    expect(result).toEqual({ kind: "oauth", provider: "google" });
  });

  it("uses an MX preset for custom domains on known hosts (source: mx)", async () => {
    const result = await discoverImapSettings("support@mystore.com", {
      ...NO_IO,
      resolveMx: async () => [{ exchange: "mx1.privateemail.com", priority: 10 }],
    });
    expect(result).toMatchObject({
      kind: "settings",
      source: "mx",
      providerName: "Namecheap Private Email",
      settings: { imapHost: "mail.privateemail.com" },
    });
  });

  it("falls back to ISPDB for the MX host's registrable domain (source: mx)", async () => {
    const fetchText = vi.fn(async (url: string) =>
      url === ispdbUrl("zoho.com") ? ZOHO_XML : null,
    );
    const result = await discoverImapSettings("support@mystore.com", {
      ...NO_IO,
      fetchText,
      resolveMx: async () => [{ exchange: "mx2.zoho.com", priority: 10 }],
    });
    // mx2.zoho.com is matched by the explicit zoho preset before ISPDB —
    // use an MX host with no preset to prove the ISPDB-on-MX-domain leg.
    const unknownMx = await discoverImapSettings("support@mystore.com", {
      ...NO_IO,
      fetchText: async (url: string) =>
        url === ispdbUrl("examplemail.net") ? STARTTLS_LOCALPART_XML : null,
      resolveMx: async () => [
        { exchange: "mx-in.examplemail.net", priority: 10 },
      ],
    });
    expect(result.kind).toBe("settings");
    expect(unknownMx).toMatchObject({
      kind: "settings",
      source: "mx",
      settings: { imapHost: "imap.example.net" },
    });
  });

  it("guesses imap./smtp. subdomains when they exist (source: guess)", async () => {
    const result = await discoverImapSettings("support@mystore.com", {
      ...NO_IO,
      hostExists: async (host: string) =>
        host === "imap.mystore.com" || host === "smtp.mystore.com",
    });
    expect(result).toEqual({
      kind: "settings",
      source: "guess",
      providerName: null,
      appPasswordUrl: null,
      passwordHint: "regular",
      settings: {
        imapHost: "imap.mystore.com",
        imapPort: 993,
        imapSecure: true,
        smtpHost: "smtp.mystore.com",
        smtpPort: 465,
        smtpSecure: true,
        username: null,
      },
    });
  });

  it("falls back to mail.<domain> when imap./smtp. don't resolve", async () => {
    const result = await discoverImapSettings("support@mystore.com", {
      ...NO_IO,
      hostExists: async (host: string) => host === "mail.mystore.com",
    });
    expect(result).toMatchObject({
      kind: "settings",
      source: "guess",
      settings: { imapHost: "mail.mystore.com", smtpHost: "mail.mystore.com" },
    });
  });

  it("returns unknown when nothing resolves", async () => {
    const result = await discoverImapSettings("support@mystore.com", NO_IO);
    expect(result).toEqual({ kind: "unknown" });
  });

  it("survives throwing IO (DNS/network errors fall through to the next step)", async () => {
    const result = await discoverImapSettings("support@mystore.com", {
      fetchText: async () => {
        throw new Error("network down");
      },
      resolveMx: async () => {
        throw new Error("ENOTFOUND");
      },
      hostExists: async (host: string) =>
        host === "imap.mystore.com" || host === "smtp.mystore.com",
    });
    expect(result).toMatchObject({ kind: "settings", source: "guess" });
  });
});

describe("ispdbUrl", () => {
  it("targets the Thunderbird ISPDB with the encoded domain", () => {
    expect(ispdbUrl("zoho.com")).toBe(
      "https://autoconfig.thunderbird.net/v1.1/zoho.com",
    );
  });
});
