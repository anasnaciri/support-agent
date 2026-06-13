/**
 * Shared connector metadata + icons used by both the integrations
 * overview (`/settings/integrations`, minimal cards) and the per-connector
 * manage page (`/settings/integrations/[provider]`, full detail).
 */

import Image from "next/image";

import gmailLogo from "./_logos/Gmail_icon_(2026).svg";
import googleSheetsLogo from "./_logos/Google_Sheets_icon_(2026).svg";
import outlookLogo from "./_logos/Microsoft_Outlook_Icon_(2025–present).svg";

export const SUPPORTED_PROVIDERS = [
  "shopify",
  "gmail",
  "google_sheets",
  "outlook",
  "imap",
] as const;

export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

export const isSupportedProvider = (
  value: string,
): value is SupportedProvider =>
  (SUPPORTED_PROVIDERS as readonly string[]).includes(value);

export const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  shopify: "Shopify",
  gmail: "Gmail",
  google_sheets: "Google Sheets",
  outlook: "Outlook",
  imap: "IMAP / SMTP",
};

export const PROVIDER_DESCRIPTIONS: Readonly<Record<string, string>> = {
  shopify:
    "Lets your agents look up orders, customers, and fulfillments. Connects through the managed Shopify app.",
  gmail:
    "Receives customer emails and sends replies from this mailbox. Connects with your Google account.",
  google_sheets:
    "Lets your agents read and add rows in your spreadsheets. Connects with your Google account.",
  outlook:
    "Receives customer emails and sends replies from this mailbox (Outlook / Microsoft 365). Connects with your Microsoft account.",
  imap: "Any other mailbox — PrivateEmail, Zoho, Fastmail, cPanel, custom domains. Just the address + an app password; server settings are detected automatically.",
};

const ShopifyIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="-18 0 292 292"
    className="size-5 shrink-0"
    preserveAspectRatio="xMidYMid"
    aria-hidden="true"
    focusable="false"
  >
    <path
      d="M223.774 57.34c-.201-1.46-1.48-2.268-2.537-2.357-1.055-.088-23.383-1.743-23.383-1.743s-15.507-15.395-17.209-17.099c-1.703-1.703-5.029-1.185-6.32-.805-.19.056-3.388 1.043-8.678 2.68-5.18-14.906-14.322-28.604-30.405-28.604-.444 0-.901.018-1.358.044C129.31 3.407 123.644.779 118.75.779c-37.465 0-55.364 46.835-60.976 70.635-14.558 4.511-24.9 7.718-26.221 8.133-8.126 2.549-8.383 2.805-9.45 10.462C21.3 95.806.038 260.235.038 260.235l165.678 31.042 89.77-19.42S223.973 58.8 223.775 57.34zM156.49 40.848l-14.019 4.339c.005-.988.01-1.96.01-3.023 0-9.264-1.286-16.723-3.349-22.636 8.287 1.04 13.806 10.469 17.358 21.32zm-27.638-19.483c2.304 5.773 3.802 14.058 3.802 25.238 0 .572-.005 1.095-.01 1.624-9.117 2.824-19.024 5.89-28.953 8.966 5.575-21.516 16.025-31.908 25.161-35.828zm-11.131-10.537c1.617 0 3.246.549 4.805 1.622-12.007 5.65-24.877 19.88-30.312 48.297l-22.886 7.088C75.694 46.16 90.81 10.828 117.72 10.828z"
      fill="#95BF46"
    />
    <path
      d="M221.237 54.983c-1.055-.088-23.383-1.743-23.383-1.743s-15.507-15.395-17.209-17.099c-.637-.634-1.496-.959-2.394-1.099l-12.527 256.233 89.762-19.418S223.972 58.8 223.774 57.34c-.201-1.46-1.48-2.268-2.537-2.357"
      fill="#5E8E3E"
    />
    <path
      d="M135.242 104.585l-11.069 32.926s-9.698-5.176-21.586-5.176c-17.428 0-18.305 10.937-18.305 13.693 0 15.038 39.2 20.8 39.2 56.024 0 27.713-17.577 45.558-41.277 45.558-28.44 0-42.984-17.7-42.984-17.7l7.615-25.16s14.95 12.835 27.565 12.835c8.243 0 11.596-6.49 11.596-11.232 0-19.616-32.16-20.491-32.16-52.724 0-27.129 19.472-53.382 58.778-53.382 15.145 0 22.627 4.338 22.627 4.338"
      fill="#FFF"
    />
  </svg>
);

const GmailIcon = () => (
  <Image
    src={gmailLogo}
    alt=""
    className="size-5 shrink-0 object-contain"
    aria-hidden
  />
);

const GoogleSheetsIcon = () => (
  <Image
    src={googleSheetsLogo}
    alt=""
    className="size-5 shrink-0 object-contain"
    aria-hidden
  />
);

const OutlookIcon = () => (
  <Image
    src={outlookLogo}
    alt=""
    className="size-5 shrink-0 object-contain"
    aria-hidden
  />
);

// Generic mail glyph — IMAP/SMTP is a protocol, not a brand.
const ImapIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    className="size-5 shrink-0"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <rect x="2.5" y="4.5" width="19" height="15" rx="2.5" />
    <path d="m3.5 6.5 8.5 6 8.5-6" />
  </svg>
);

export const PROVIDER_ICONS = {
  shopify: ShopifyIcon,
  gmail: GmailIcon,
  google_sheets: GoogleSheetsIcon,
  outlook: OutlookIcon,
  imap: ImapIcon,
} satisfies Readonly<Record<SupportedProvider, typeof ShopifyIcon>>;

const originFromEnvUrl = (raw: string | undefined): string | null => {
  const value = raw?.trim();
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

export const getApiBaseUrl = (): string | null =>
  originFromEnvUrl(process.env["DASHBOARD_API_BASE_URL"]) ??
  originFromEnvUrl(process.env["SHOPIFY_APP_CALLBACK_URL"]) ??
  originFromEnvUrl(process.env["GOOGLE_OAUTH_CALLBACK_URL"]) ??
  originFromEnvUrl(process.env["APPROVAL_BASE_URL"]);

/**
 * The Connect / Reconnect / Reinstall href for a provider. Points at the
 * dashboard's OWN `/connect/<provider>` route (same origin), NOT the api
 * install URL with a raw `?tenant=`. That route authenticates the user via
 * their WorkOS session, has the api mint a short-lived signed install grant
 * for THEIR tenant, then redirects to the provider OAuth — so the tenant is
 * never client-supplied and one merchant can't start an install for another
 * (5th-audit #2).
 */
export const connectHref = (provider: SupportedProvider): string =>
  `/connect/${provider}`;
