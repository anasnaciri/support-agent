// ============================================================
// IMAP connect plan — pure decision logic for the connect form
// ============================================================
//
// The form shows only email + app password by default; host/port/security
// live in a collapsed Advanced section. Given the raw form values, this
// decides whether to connect with manual settings, autodiscover first (via
// the injected callback → POST /dashboard/connections/imap/discover), send
// the merchant to an OAuth connector, or ask them to fill in the servers.

/** Mirror of the api's `DiscoveredSettings` (imap-discovery.ts). */
export interface DiscoveredImapSettings {
  readonly imapHost: string;
  readonly imapPort: number;
  readonly imapSecure: boolean;
  readonly smtpHost: string;
  readonly smtpPort: number;
  readonly smtpSecure: boolean;
  readonly username: string | null;
}

/** Mirror of the api's `PasswordHint` (imap-discovery.ts). */
export type PasswordHint = "regular" | "app_password" | "app_password_if_2fa";

/** Mirror of the api's `ImapDiscovery` response. */
export type ImapDiscoveryResponse =
  | { readonly kind: "oauth"; readonly provider: "google" | "outlook" }
  | {
      readonly kind: "settings";
      readonly source: "ispdb" | "mx" | "guess";
      readonly providerName: string | null;
      readonly appPasswordUrl: string | null;
      readonly passwordHint: PasswordHint;
      readonly settings: DiscoveredImapSettings;
    }
  | { readonly kind: "unknown" };

export type DiscoveredPrefill = Extract<
  ImapDiscoveryResponse,
  { kind: "settings" }
>;

export interface PasswordGuidance {
  readonly message: string;
  readonly link: { readonly href: string; readonly label: string } | null;
}

/**
 * Copy for the "couldn't sign in" alert, tailored to what the detected
 * provider actually wants — so we stop telling every merchant to create an
 * app password. Namecheap & co. sign in with the normal mailbox password;
 * only Fastmail/Zoho/Yahoo/… genuinely require an app password.
 */
export const passwordGuidanceForFailure = (
  discovered: DiscoveredPrefill | null,
): PasswordGuidance => {
  if (!discovered) {
    return {
      message:
        "We couldn't sign in with those details. Check the server settings and password.",
      link: null,
    };
  }
  const provider = discovered.providerName ?? "your mail provider";
  const appPasswordLink = discovered.appPasswordUrl
    ? { href: discovered.appPasswordUrl, label: "Create an app password" }
    : null;

  switch (discovered.passwordHint) {
    case "regular":
      return {
        message: `We found the settings for ${provider} but sign-in failed. Use your normal mailbox password — not an app password — and double-check it.`,
        link: null,
      };
    case "app_password_if_2fa":
      return {
        message: `We found the settings for ${provider} but sign-in failed. Use your normal mailbox password. Only create an app password if you've turned on two-factor authentication.`,
        link: appPasswordLink,
      };
    case "app_password":
    default:
      return {
        message: `We found the settings for ${provider} but sign-in failed. ${provider} needs an app password created in its security settings, not your normal password.`,
        link: appPasswordLink,
      };
  }
};

/** Raw (string) values as read from the form's FormData. */
export interface ImapFormValues {
  readonly mailbox: string;
  readonly password: string;
  readonly user: string;
  readonly imapHost: string;
  readonly imapPort: string;
  readonly imapSecure: string;
  readonly smtpHost: string;
  readonly smtpPort: string;
  readonly smtpSecure: string;
}

export interface ImapConnectInput {
  readonly mailbox: string;
  readonly password: string;
  readonly imapHost: string;
  readonly imapPort: number;
  readonly imapSecure: boolean;
  readonly smtpHost: string;
  readonly smtpPort: number;
  readonly smtpSecure: boolean;
  readonly user?: string;
}

export type ImapConnectPlan =
  | { readonly action: "error"; readonly error: "missing_fields" | "missing_hosts" }
  | { readonly action: "oauth"; readonly provider: "google" | "outlook" }
  | { readonly action: "needs_settings" }
  | {
      readonly action: "connect";
      readonly input: ImapConnectInput;
      /** Set when the settings came from discovery — the failure re-render
       * uses it to open + prefill Advanced and show provider help. */
      readonly discovered: DiscoveredPrefill | null;
    };

const parsePort = (raw: string, fallback: number): number => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : fallback;
};

/**
 * The api's connectivity check fails with the raw mail-library message
 * (node-imap / nodemailer `Error#message`). Map the common failure families
 * to plain words for the form's error alert; anything unrecognized returns
 * null and is dropped rather than shown verbatim.
 */
export const friendlyConnectDetail = (
  detail: string | undefined,
): string | null => {
  if (!detail) return null;
  if (/auth|credential|password|login|535/i.test(detail)) {
    return "The mail server rejected the username or password.";
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|dns/i.test(detail)) {
    return "We couldn't find that mail server — double-check the server address.";
  }
  if (/ECONNREFUSED|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|timed? ?out/i.test(detail)) {
    return "We couldn't reach the mail server — double-check the server address and port.";
  }
  if (/certificate|TLS|SSL|handshake/i.test(detail)) {
    return "Secure connection failed — try the other security setting for this server.";
  }
  return null;
};

export const planImapConnect = async (
  raw: ImapFormValues,
  discover: (email: string) => Promise<ImapDiscoveryResponse | null>,
): Promise<ImapConnectPlan> => {
  const mailbox = raw.mailbox.trim();
  const password = raw.password.trim();
  const user = raw.user.trim();
  const imapHost = raw.imapHost.trim();
  const smtpHost = raw.smtpHost.trim();

  if (!mailbox || !password) return { action: "error", error: "missing_fields" };

  // Advanced section filled in → trust the merchant, skip discovery.
  if (imapHost && smtpHost) {
    return {
      action: "connect",
      discovered: null,
      input: {
        mailbox,
        password,
        imapHost,
        imapPort: parsePort(raw.imapPort, 993),
        imapSecure: raw.imapSecure.trim() !== "false",
        smtpHost,
        smtpPort: parsePort(raw.smtpPort, 465),
        smtpSecure: raw.smtpSecure.trim() !== "false",
        ...(user ? { user } : {}),
      },
    };
  }
  if (imapHost || smtpHost) return { action: "error", error: "missing_hosts" };

  let discovery: ImapDiscoveryResponse | null;
  try {
    discovery = await discover(mailbox);
  } catch {
    discovery = null;
  }
  if (!discovery || discovery.kind === "unknown") {
    return { action: "needs_settings" };
  }
  if (discovery.kind === "oauth") {
    return { action: "oauth", provider: discovery.provider };
  }
  const { settings } = discovery;
  const loginUser = user || settings.username || "";
  return {
    action: "connect",
    discovered: discovery,
    input: {
      mailbox,
      password,
      imapHost: settings.imapHost,
      imapPort: settings.imapPort,
      imapSecure: settings.imapSecure,
      smtpHost: settings.smtpHost,
      smtpPort: settings.smtpPort,
      smtpSecure: settings.smtpSecure,
      ...(loginUser ? { user: loginUser } : {}),
    },
  };
};
