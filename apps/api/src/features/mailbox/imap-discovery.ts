// ============================================================
// IMAP/SMTP autodiscovery — pure logic, IO injected
// ============================================================
//
// "Type your email, we find the server settings" for the generic IMAP/SMTP
// connector, so merchants never see host/port fields unless every lookup
// fails. The chain (first hit wins):
//
//   1. OAuth-provider detection — gmail.com / outlook.com style addresses
//      belong on the dedicated Google/Microsoft connectors, not IMAP.
//   2. Mozilla ISPDB (autoconfig.thunderbird.net) for the email domain —
//      the same database Thunderbird uses; covers hundreds of providers.
//   3. MX records of the (custom) domain: detect Google Workspace /
//      Microsoft 365 (→ OAuth connectors), then known mail-host suffixes
//      (→ presets), then ISPDB for the MX host's own registrable domain.
//   4. Pattern guesses (imap./smtp./mail.<domain>) filtered by DNS
//      existence. A wrong guess is harmless: the connect endpoint verifies
//      logins against both servers before persisting anything.
//
// Everything here is pure given `DiscoveryIo`; the handler in `server.ts`
// supplies real fetch/DNS implementations. The ISPDB host is a fixed,
// trusted constant — the only interpolated value is the merchant's mail
// domain, validated by `HOSTNAME_RE` first. Discovered hostnames are only
// ever *returned as form prefill* and later connectivity-checked by the
// existing connect endpoint, the same trust level as merchant-typed hosts.

export interface DiscoveredSettings {
  readonly imapHost: string;
  readonly imapPort: number;
  readonly imapSecure: boolean;
  readonly smtpHost: string;
  readonly smtpPort: number;
  readonly smtpSecure: boolean;
  /** Login username when it differs from the mailbox address (else null). */
  readonly username: string | null;
}

export type OAuthMailProvider = "google" | "outlook";

/**
 * What kind of password this provider expects for IMAP/SMTP sign-in, so the
 * form's copy can stop assuming everyone needs an "app password":
 *  - `regular`             — the normal mailbox password (custom domains, OVH…)
 *  - `app_password`        — a security-settings app password is required
 *                            (Fastmail, Zoho, Yahoo, iCloud…)
 *  - `app_password_if_2fa` — the normal password works; an app password is
 *                            only needed once two-factor auth is on (Namecheap)
 */
export type PasswordHint = "regular" | "app_password" | "app_password_if_2fa";

export type ImapDiscovery =
  | { readonly kind: "oauth"; readonly provider: OAuthMailProvider }
  | {
      readonly kind: "settings";
      readonly source: "ispdb" | "mx" | "guess";
      readonly providerName: string | null;
      readonly appPasswordUrl: string | null;
      readonly passwordHint: PasswordHint;
      readonly settings: DiscoveredSettings;
    }
  | { readonly kind: "unknown" };

/** IO seams — real impls in `server.ts`, fakes in tests. */
export interface DiscoveryIo {
  /** GET `url` → body text, or null on a non-2xx/error response. */
  readonly fetchText: (url: string) => Promise<string | null>;
  readonly resolveMx: (
    domain: string,
  ) => Promise<ReadonlyArray<{ readonly exchange: string; readonly priority: number }>>;
  /** True when `host` has at least one DNS address record. */
  readonly hostExists: (host: string) => Promise<boolean>;
}

// One label of safe charset, no leading/trailing hyphen; two+ labels total.
const HOSTNAME_RE =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Lowercased mail domain of `email`, or null when it isn't a safe email. */
export const mailDomainFromEmail = (email: string): string | null => {
  const parts = email.trim().split("@");
  if (parts.length !== 2) return null;
  const [local, rawDomain] = parts as [string, string];
  if (local.length === 0) return null;
  const domain = rawDomain.toLowerCase();
  return HOSTNAME_RE.test(domain) ? domain : null;
};

const hasSuffix = (host: string, suffix: string): boolean =>
  host === suffix || host.endsWith(`.${suffix}`);

// ============================================================
// OAuth-provider detection
// ============================================================

const OAUTH_DOMAINS: Readonly<Record<string, OAuthMailProvider>> = {
  "gmail.com": "google",
  "googlemail.com": "google",
  "outlook.com": "outlook",
  "hotmail.com": "outlook",
  "live.com": "outlook",
  "msn.com": "outlook",
};

export const oauthProviderForDomain = (
  domain: string,
): OAuthMailProvider | null => OAUTH_DOMAINS[domain.toLowerCase()] ?? null;

// Custom domains hosted on Google Workspace / Microsoft 365 — basic-auth
// IMAP is dead or dying on both, so route them to the OAuth connectors.
const OAUTH_MX_SUFFIXES: ReadonlyArray<
  readonly [suffix: string, provider: OAuthMailProvider]
> = [
  ["google.com", "google"],
  ["googlemail.com", "google"],
  ["mail.protection.outlook.com", "outlook"],
  ["olc.protection.outlook.com", "outlook"],
];

export const oauthProviderForMxHost = (
  mxHost: string,
): OAuthMailProvider | null => {
  const host = mxHost.toLowerCase();
  for (const [suffix, provider] of OAUTH_MX_SUFFIXES) {
    if (hasSuffix(host, suffix)) return provider;
  }
  return null;
};

// ============================================================
// App-password help — keyed by provider/registrable domain
// ============================================================

const APP_PASSWORD_URLS: Readonly<Record<string, string>> = {
  "zoho.com": "https://accounts.zoho.com/home#security",
  "fastmail.com":
    "https://www.fastmail.help/hc/en-us/articles/360058752854-App-passwords",
  "yahoo.com": "https://help.yahoo.com/kb/SLN15241.html",
  "aol.com": "https://help.aol.com/articles/Create-and-manage-app-password",
  "apple.com": "https://support.apple.com/102654",
  "icloud.com": "https://support.apple.com/102654",
  "privateemail.com":
    "https://www.namecheap.com/support/knowledgebase/article.aspx/10374/2178/how-to-set-up-applicationspecific-password-for-private-email/",
};

export const appPasswordUrlFor = (providerId: string): string | null =>
  APP_PASSWORD_URLS[providerId.toLowerCase()] ?? null;

// ISPDB and pattern-guess paths don't carry a provider-specific policy, so
// derive the hint from whether we know an app-password page: known providers
// (Fastmail, Zoho, …) require one; everything else uses the mailbox password.
const hintFromAppPasswordUrl = (url: string | null): PasswordHint =>
  url ? "app_password" : "regular";

// ============================================================
// ISPDB clientConfig XML parsing
// ============================================================

const firstChild = (block: string, tag: string): string | null => {
  const m = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, "i"));
  return m ? m[1]!.trim() : null;
};

const serverBlocks = (
  xml: string,
  element: "incomingServer" | "outgoingServer",
  type: string,
): ReadonlyArray<string> => {
  const blocks: Array<string> = [];
  const re = new RegExp(`<${element}\\b([^>]*)>([\\s\\S]*?)</${element}>`, "gi");
  for (const m of xml.matchAll(re)) {
    if (new RegExp(`type="${type}"`, "i").test(m[1]!)) blocks.push(m[2]!);
  }
  return blocks;
};

const resolvePlaceholders = (value: string, email: string): string => {
  const at = email.indexOf("@");
  const local = at >= 0 ? email.slice(0, at) : email;
  const domain = at >= 0 ? email.slice(at + 1) : "";
  return value
    .replaceAll("%EMAILADDRESS%", email)
    .replaceAll("%EMAILLOCALPART%", local)
    .replaceAll("%EMAILDOMAIN%", domain);
};

const parseServer = (
  block: string,
  email: string,
  defaults: { readonly ssl: number; readonly starttls: number },
): { host: string; port: number; secure: boolean } | null => {
  const rawHost = firstChild(block, "hostname");
  if (!rawHost) return null;
  const host = resolvePlaceholders(rawHost, email).toLowerCase();
  if (!HOSTNAME_RE.test(host)) return null;
  // SSL = implicit TLS; STARTTLS (and anything else) maps to secure:false,
  // which our transport treats as *required* STARTTLS — never cleartext.
  const secure = (firstChild(block, "socketType") ?? "SSL").toUpperCase() === "SSL";
  const rawPort = Number(firstChild(block, "port"));
  const port =
    Number.isInteger(rawPort) && rawPort > 0 && rawPort <= 65535
      ? rawPort
      : secure
        ? defaults.ssl
        : defaults.starttls;
  return { host, port, secure };
};

export interface IspdbConfig {
  readonly providerId: string | null;
  readonly providerName: string | null;
  readonly settings: DiscoveredSettings;
}

/** Parses an ISPDB clientConfig document; null when no usable imap+smtp. */
export const parseIspdbXml = (
  xml: string,
  email: string,
): IspdbConfig | null => {
  const imapBlock = serverBlocks(xml, "incomingServer", "imap")[0];
  const smtpBlock = serverBlocks(xml, "outgoingServer", "smtp")[0];
  if (!imapBlock || !smtpBlock) return null;
  const imap = parseServer(imapBlock, email, { ssl: 993, starttls: 143 });
  const smtp = parseServer(smtpBlock, email, { ssl: 465, starttls: 587 });
  if (!imap || !smtp) return null;

  const rawUsername = firstChild(imapBlock, "username");
  const username = rawUsername ? resolvePlaceholders(rawUsername, email) : null;

  return {
    providerId: xml.match(/<emailProvider\b[^>]*\bid="([^"]*)"/i)?.[1] ?? null,
    providerName: firstChild(xml, "displayName"),
    settings: {
      imapHost: imap.host,
      imapPort: imap.port,
      imapSecure: imap.secure,
      smtpHost: smtp.host,
      smtpPort: smtp.port,
      smtpSecure: smtp.secure,
      // The connect endpoint already defaults the login user to the mailbox.
      username:
        username && username.toLowerCase() !== email.toLowerCase()
          ? username
          : null,
    },
  };
};

// ============================================================
// MX-suffix presets — custom domains on known mail hosts
// ============================================================

interface MxPreset {
  readonly suffix: string;
  readonly providerName: string;
  /** Key into APP_PASSWORD_URLS (when the provider needs app passwords). */
  readonly appPasswordProvider: string | null;
  readonly passwordHint: PasswordHint;
  readonly imapHost: string;
  readonly smtpHost: string;
  readonly smtpPort?: number;
}

const MX_PRESETS: ReadonlyArray<MxPreset> = [
  {
    suffix: "privateemail.com",
    providerName: "Namecheap Private Email",
    // IMAP/SMTP take the normal mailbox password; the app-password picker has
    // no "IMAP" entry and is only needed once 2FA is enabled.
    appPasswordProvider: "privateemail.com",
    passwordHint: "app_password_if_2fa",
    imapHost: "mail.privateemail.com",
    smtpHost: "mail.privateemail.com",
  },
  {
    suffix: "zoho.com",
    providerName: "Zoho Mail",
    appPasswordProvider: "zoho.com",
    passwordHint: "app_password",
    imapHost: "imap.zoho.com",
    smtpHost: "smtp.zoho.com",
  },
  {
    suffix: "zoho.eu",
    providerName: "Zoho Mail",
    appPasswordProvider: "zoho.com",
    passwordHint: "app_password",
    imapHost: "imap.zoho.eu",
    smtpHost: "smtp.zoho.eu",
  },
  {
    suffix: "zoho.in",
    providerName: "Zoho Mail",
    appPasswordProvider: "zoho.com",
    passwordHint: "app_password",
    imapHost: "imap.zoho.in",
    smtpHost: "smtp.zoho.in",
  },
  {
    suffix: "messagingengine.com",
    providerName: "Fastmail",
    appPasswordProvider: "fastmail.com",
    passwordHint: "app_password",
    imapHost: "imap.fastmail.com",
    smtpHost: "smtp.fastmail.com",
  },
  {
    suffix: "secureserver.net",
    providerName: "GoDaddy Email",
    appPasswordProvider: null,
    passwordHint: "regular",
    imapHost: "imap.secureserver.net",
    smtpHost: "smtpout.secureserver.net",
  },
  {
    suffix: "mx.yandex.net",
    providerName: "Yandex Mail",
    // Yandex blocks the account password over IMAP — an app password is
    // mandatory — but we have no stable deep link, so leave the URL null.
    appPasswordProvider: null,
    passwordHint: "app_password",
    imapHost: "imap.yandex.com",
    smtpHost: "smtp.yandex.com",
  },
  {
    suffix: "mail.ovh.net",
    providerName: "OVHcloud Mail",
    appPasswordProvider: null,
    passwordHint: "regular",
    imapHost: "ssl0.ovh.net",
    smtpHost: "ssl0.ovh.net",
  },
  {
    suffix: "ionos.de",
    providerName: "IONOS",
    appPasswordProvider: null,
    passwordHint: "regular",
    imapHost: "imap.ionos.de",
    smtpHost: "smtp.ionos.de",
  },
  {
    suffix: "ionos.com",
    providerName: "IONOS",
    appPasswordProvider: null,
    passwordHint: "regular",
    imapHost: "imap.ionos.com",
    smtpHost: "smtp.ionos.com",
  },
];

export interface MxPresetMatch {
  readonly providerName: string;
  readonly appPasswordUrl: string | null;
  readonly passwordHint: PasswordHint;
  readonly settings: DiscoveredSettings;
}

export const presetForMxHost = (mxHost: string): MxPresetMatch | null => {
  const host = mxHost.toLowerCase();
  for (const preset of MX_PRESETS) {
    if (!hasSuffix(host, preset.suffix)) continue;
    return {
      providerName: preset.providerName,
      appPasswordUrl: preset.appPasswordProvider
        ? appPasswordUrlFor(preset.appPasswordProvider)
        : null,
      passwordHint: preset.passwordHint,
      settings: {
        imapHost: preset.imapHost,
        imapPort: 993,
        imapSecure: true,
        smtpHost: preset.smtpHost,
        smtpPort: preset.smtpPort ?? 465,
        smtpSecure: true,
        username: null,
      },
    };
  }
  return null;
};

/** Naive eTLD+1 (last two labels) — fine for mail-host MX targets. */
export const registrableDomain = (host: string): string | null => {
  const labels = host.toLowerCase().split(".").filter((l) => l.length > 0);
  if (labels.length < 2) return null;
  return labels.slice(-2).join(".");
};

// ============================================================
// Orchestration
// ============================================================

export const ispdbUrl = (domain: string): string =>
  `https://autoconfig.thunderbird.net/v1.1/${encodeURIComponent(domain)}`;

const ispdbLookup = async (
  domain: string,
  email: string,
  io: DiscoveryIo,
): Promise<Omit<MxPresetMatch, "providerName"> & {
  readonly providerName: string | null;
} | null> => {
  let xml: string | null;
  try {
    xml = await io.fetchText(ispdbUrl(domain));
  } catch {
    return null;
  }
  if (!xml) return null;
  const parsed = parseIspdbXml(xml, email);
  if (!parsed) return null;
  const appPasswordUrl = appPasswordUrlFor(
    parsed.providerId ?? registrableDomain(parsed.settings.imapHost) ?? "",
  );
  return {
    providerName: parsed.providerName,
    appPasswordUrl,
    passwordHint: hintFromAppPasswordUrl(appPasswordUrl),
    settings: parsed.settings,
  };
};

const firstExistingHost = async (
  hosts: ReadonlyArray<string>,
  io: DiscoveryIo,
): Promise<string | null> => {
  for (const host of hosts) {
    try {
      if (await io.hostExists(host)) return host;
    } catch {
      // DNS errors = host unusable; try the next candidate.
    }
  }
  return null;
};

export const discoverImapSettings = async (
  email: string,
  io: DiscoveryIo,
): Promise<ImapDiscovery> => {
  const domain = mailDomainFromEmail(email);
  if (!domain) return { kind: "unknown" };

  const oauthByDomain = oauthProviderForDomain(domain);
  if (oauthByDomain) return { kind: "oauth", provider: oauthByDomain };

  const viaIspdb = await ispdbLookup(domain, email, io);
  if (viaIspdb) return { kind: "settings", source: "ispdb", ...viaIspdb };

  let mxHosts: ReadonlyArray<string> = [];
  try {
    mxHosts = (await io.resolveMx(domain))
      .slice()
      .sort((a, b) => a.priority - b.priority)
      .map((r) => r.exchange.toLowerCase());
  } catch {
    // No MX (or DNS down) — fall through to pattern guesses.
  }
  for (const mx of mxHosts) {
    const oauthByMx = oauthProviderForMxHost(mx);
    if (oauthByMx) return { kind: "oauth", provider: oauthByMx };
    const preset = presetForMxHost(mx);
    if (preset) return { kind: "settings", source: "mx", ...preset };
  }
  const primaryMxDomain = mxHosts[0] ? registrableDomain(mxHosts[0]) : null;
  if (primaryMxDomain && primaryMxDomain !== domain) {
    const viaMx = await ispdbLookup(primaryMxDomain, email, io);
    if (viaMx) return { kind: "settings", source: "mx", ...viaMx };
  }

  const imapHost = await firstExistingHost(
    [`imap.${domain}`, `mail.${domain}`],
    io,
  );
  const smtpHost = await firstExistingHost(
    [`smtp.${domain}`, `mail.${domain}`],
    io,
  );
  if (imapHost && smtpHost) {
    return {
      kind: "settings",
      source: "guess",
      providerName: null,
      appPasswordUrl: null,
      passwordHint: "regular",
      settings: {
        imapHost,
        imapPort: 993,
        imapSecure: true,
        smtpHost,
        smtpPort: 465,
        smtpSecure: true,
        username: null,
      },
    };
  }
  return { kind: "unknown" };
};
