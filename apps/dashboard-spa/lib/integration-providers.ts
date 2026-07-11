/**
 * Shared connector metadata used by both the integrations overview
 * (`/settings/integrations`, minimal cards) and the per-connector manage page
 * (`/settings/integrations/:provider`, full detail).
 *
 * The pure (framework-free) half of the Next app's
 * `app/settings/integrations/_shared.tsx`: provider list + labels +
 * descriptions. The brand icons live in the page components instead, because
 * they import SVG assets and render React — keeping this module pure so
 * `connect-error.ts` (which needs `PROVIDER_LABELS`) stays unit-testable.
 */

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
  imap: "Any other mailbox: PrivateEmail, Zoho, Fastmail, cPanel, custom domains. Just the address + an app password; server settings are detected automatically.",
};
