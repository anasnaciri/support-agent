import { describe, expect, it, vi } from "vitest";

import {
  friendlyConnectDetail,
  passwordGuidanceForFailure,
  planImapConnect,
  type DiscoveredPrefill,
  type ImapDiscoveryResponse,
  type ImapFormValues,
} from "../lib/connect-plan";

// The connect form only shows email + app password by default; server
// settings come from the api's autodiscovery unless the merchant filled the
// Advanced section. This plans the action's next move from form values +
// a discovery callback (only invoked when discovery is actually needed).

const values = (over: Partial<ImapFormValues> = {}): ImapFormValues => ({
  mailbox: "support@mystore.com",
  password: "app-pass",
  user: "",
  imapHost: "",
  imapPort: "",
  imapSecure: "",
  smtpHost: "",
  smtpPort: "",
  smtpSecure: "",
  ...over,
});

const settingsDiscovery: ImapDiscoveryResponse = {
  kind: "settings",
  source: "ispdb",
  providerName: "Zoho Mail",
  appPasswordUrl: "https://accounts.zoho.com/home#security",
  passwordHint: "app_password",
  settings: {
    imapHost: "imap.zoho.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.zoho.com",
    smtpPort: 465,
    smtpSecure: true,
    username: null,
  },
};

const never = vi.fn(async (): Promise<ImapDiscoveryResponse | null> => {
  throw new Error("discover must not be called");
});

describe("planImapConnect", () => {
  it("requires mailbox and password before anything else", async () => {
    expect(await planImapConnect(values({ mailbox: "" }), never)).toEqual({
      action: "error",
      error: "missing_fields",
    });
    expect(await planImapConnect(values({ password: " " }), never)).toEqual({
      action: "error",
      error: "missing_fields",
    });
    expect(never).not.toHaveBeenCalled();
  });

  it("uses manual settings verbatim without calling discovery", async () => {
    const plan = await planImapConnect(
      values({
        imapHost: "imap.example.com",
        imapPort: "143",
        imapSecure: "false",
        smtpHost: "smtp.example.com",
        smtpPort: "587",
        smtpSecure: "false",
        user: "login@example.com",
      }),
      never,
    );
    expect(plan).toEqual({
      action: "connect",
      discovered: null,
      input: {
        mailbox: "support@mystore.com",
        password: "app-pass",
        imapHost: "imap.example.com",
        imapPort: 143,
        imapSecure: false,
        smtpHost: "smtp.example.com",
        smtpPort: 587,
        smtpSecure: false,
        user: "login@example.com",
      },
    });
    expect(never).not.toHaveBeenCalled();
  });

  it("defaults manual ports/security like the old form did", async () => {
    const plan = await planImapConnect(
      values({ imapHost: "imap.example.com", smtpHost: "smtp.example.com" }),
      never,
    );
    expect(plan.action).toBe("connect");
    if (plan.action !== "connect") return;
    expect(plan.input).toMatchObject({
      imapPort: 993,
      imapSecure: true,
      smtpPort: 465,
      smtpSecure: true,
    });
    expect(plan.input).not.toHaveProperty("user");
  });

  it("flags a half-filled Advanced section instead of discovering", async () => {
    expect(
      await planImapConnect(values({ imapHost: "imap.example.com" }), never),
    ).toEqual({ action: "error", error: "missing_hosts" });
    expect(
      await planImapConnect(values({ smtpHost: "smtp.example.com" }), never),
    ).toEqual({ action: "error", error: "missing_hosts" });
  });

  it("routes gmail-style addresses to the OAuth connector", async () => {
    const plan = await planImapConnect(values(), async () => ({
      kind: "oauth",
      provider: "google",
    }));
    expect(plan).toEqual({ action: "oauth", provider: "google" });
  });

  it("connects with discovered settings and carries the prefill for failures", async () => {
    const discover = vi.fn(async () => settingsDiscovery);
    const plan = await planImapConnect(values(), discover);
    expect(discover).toHaveBeenCalledWith("support@mystore.com");
    expect(plan).toEqual({
      action: "connect",
      discovered: settingsDiscovery,
      input: {
        mailbox: "support@mystore.com",
        password: "app-pass",
        imapHost: "imap.zoho.com",
        imapPort: 993,
        imapSecure: true,
        smtpHost: "smtp.zoho.com",
        smtpPort: 465,
        smtpSecure: true,
      },
    });
  });

  it("passes a discovered non-default username through as the login user", async () => {
    const plan = await planImapConnect(values(), async () => ({
      ...settingsDiscovery,
      settings: { ...settingsDiscovery.settings, username: "support" },
    }));
    expect(plan.action).toBe("connect");
    if (plan.action !== "connect") return;
    expect(plan.input.user).toBe("support");
  });

  it("asks for manual settings when discovery comes up empty or fails", async () => {
    expect(
      await planImapConnect(values(), async () => ({ kind: "unknown" })),
    ).toEqual({ action: "needs_settings" });
    expect(await planImapConnect(values(), async () => null)).toEqual({
      action: "needs_settings",
    });
  });
});

// The api's connectivity-check failure carries the raw mail-library error
// (node-imap / nodemailer `Error#message`). Merchants must never see
// `ECONNREFUSED`-style internals — map the common families to plain words
// and drop anything unrecognized.
describe("friendlyConnectDetail", () => {
  it("maps auth failures to a password hint", () => {
    expect(
      friendlyConnectDetail("Invalid credentials (Failure)"),
    ).toBe("The mail server rejected the username or password.");
    expect(friendlyConnectDetail("535 5.7.8 Authentication failed")).toBe(
      "The mail server rejected the username or password.",
    );
  });

  it("maps DNS failures to a host-name hint", () => {
    expect(friendlyConnectDetail("getaddrinfo ENOTFOUND imap.exmaple.com")).toBe(
      "We couldn't find that mail server — double-check the server address.",
    );
  });

  it("maps connection failures to a host/port hint", () => {
    expect(friendlyConnectDetail("connect ECONNREFUSED 1.2.3.4:993")).toBe(
      "We couldn't reach the mail server — double-check the server address and port.",
    );
    expect(friendlyConnectDetail("Socket timed out (ETIMEDOUT)")).toBe(
      "We couldn't reach the mail server — double-check the server address and port.",
    );
  });

  it("maps TLS failures to a security-setting hint", () => {
    expect(friendlyConnectDetail("unable to verify the first certificate")).toBe(
      "Secure connection failed — try the other security setting for this server.",
    );
  });

  it("drops anything it doesn't recognize", () => {
    expect(
      friendlyConnectDetail("Error: weird internal stack frame at foo.js:12"),
    ).toBeNull();
    expect(friendlyConnectDetail(undefined)).toBeNull();
    expect(friendlyConnectDetail("")).toBeNull();
  });
});

// After a failed sign-in the form tailors its hint to what the provider
// actually expects, instead of always telling merchants to make an app
// password (the bug that confused Namecheap users — their IMAP login is just
// the normal mailbox password).
describe("passwordGuidanceForFailure", () => {
  const prefill = (over: Partial<DiscoveredPrefill> = {}): DiscoveredPrefill => ({
    kind: "settings",
    source: "mx",
    providerName: "Example Mail",
    appPasswordUrl: null,
    passwordHint: "regular",
    settings: {
      imapHost: "imap.example.com",
      imapPort: 993,
      imapSecure: true,
      smtpHost: "smtp.example.com",
      smtpPort: 465,
      smtpSecure: true,
      username: null,
    },
    ...over,
  });

  it("gives generic guidance with no link when discovery is absent", () => {
    const g = passwordGuidanceForFailure(null);
    expect(g.link).toBeNull();
    expect(g.message).toMatch(/server settings/i);
  });

  it("tells regular-password providers to use their normal password", () => {
    const g = passwordGuidanceForFailure(
      prefill({ providerName: "OVHcloud Mail", passwordHint: "regular" }),
    );
    expect(g.message).toMatch(/normal/i);
    expect(g.message).toMatch(/not an app password/i);
    expect(g.link).toBeNull();
  });

  it("points app-password providers at their help page", () => {
    const g = passwordGuidanceForFailure(
      prefill({
        providerName: "Zoho Mail",
        passwordHint: "app_password",
        appPasswordUrl: "https://accounts.zoho.com/home#security",
      }),
    );
    expect(g.message).toMatch(/app password/i);
    expect(g.link).toEqual({
      href: "https://accounts.zoho.com/home#security",
      label: "Create an app password",
    });
  });

  it("omits the link when an app-password provider has no help url", () => {
    const g = passwordGuidanceForFailure(
      prefill({ providerName: "Yandex Mail", passwordHint: "app_password" }),
    );
    expect(g.message).toMatch(/app password/i);
    expect(g.link).toBeNull();
  });

  it("explains the 2FA-only app-password case (Namecheap)", () => {
    const g = passwordGuidanceForFailure(
      prefill({
        providerName: "Namecheap Private Email",
        passwordHint: "app_password_if_2fa",
        appPasswordUrl: "https://www.namecheap.com/support/app-password",
      }),
    );
    expect(g.message).toMatch(/normal/i);
    expect(g.message).toMatch(/two-factor|2fa/i);
    expect(g.link?.label).toBe("Create an app password");
  });

  it("names the provider when known, falling back gracefully otherwise", () => {
    expect(
      passwordGuidanceForFailure(prefill({ providerName: "Zoho Mail" })).message,
    ).toContain("Zoho Mail");
    expect(
      passwordGuidanceForFailure(prefill({ providerName: null })).message,
    ).toMatch(/your provider|your mail provider/i);
  });
});
