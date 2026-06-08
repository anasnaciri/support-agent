// Pure nav model for the Settings secondary sidebar — no React/icon imports
// so the active-matching logic stays unit-testable. The client component
// (settings-nav.tsx) decorates each href with its icon.

export interface SettingsNavItem {
  readonly href: string;
  readonly label: string;
  /** True when `pathname` should highlight this item. */
  readonly match: (pathname: string) => boolean;
}

export interface SettingsNavGroup {
  /** Section heading; omitted for the ungrouped top items. */
  readonly label?: string;
  readonly items: ReadonlyArray<SettingsNavItem>;
}

const exact =
  (href: string) =>
  (pathname: string): boolean =>
    pathname === href;

const prefix =
  (href: string) =>
  (pathname: string): boolean =>
    pathname === href || pathname.startsWith(`${href}/`);

export const SETTINGS_NAV_GROUPS: ReadonlyArray<SettingsNavGroup> = [
  {
    items: [{ href: "/settings", label: "Overview", match: exact("/settings") }],
  },
  {
    label: "Workspace",
    items: [
      { href: "/settings/agents", label: "Agents", match: prefix("/settings/agents") },
      {
        href: "/settings/permissions",
        label: "Tool permissions",
        match: prefix("/settings/permissions"),
      },
      { href: "/settings/llm", label: "LLM provider", match: prefix("/settings/llm") },
      {
        href: "/settings/refund-policy",
        label: "Refund policy",
        match: prefix("/settings/refund-policy"),
      },
      { href: "/settings/usage", label: "Usage", match: prefix("/settings/usage") },
    ],
  },
  {
    label: "Connections",
    items: [
      {
        href: "/settings/integrations",
        label: "Integrations",
        // Covers every provider, including the Google Sheets connector that
        // hosts supplier escalation (reached via Integrations → manage) and
        // its legacy /settings/supplier-escalation redirect URL.
        match: (pathname) =>
          pathname === "/settings/integrations" ||
          pathname.startsWith("/settings/integrations/") ||
          pathname === "/settings/supplier-escalation" ||
          pathname.startsWith("/settings/supplier-escalation/"),
      },
    ],
  },
  {
    label: "Account",
    items: [
      { href: "/settings/legal", label: "Legal", match: prefix("/settings/legal") },
      {
        href: "/settings/account",
        label: "Delete account",
        match: prefix("/settings/account"),
      },
    ],
  },
];

/** The href of the nav item that should be highlighted, or null. */
export const activeSettingsHref = (pathname: string): string | null => {
  for (const group of SETTINGS_NAV_GROUPS) {
    for (const item of group.items) {
      if (item.match(pathname)) return item.href;
    }
  }
  return null;
};
