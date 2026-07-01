// Pure nav model for the Settings secondary sidebar — no React/icon imports
// so the active-matching logic stays unit-testable. The client component
// (settings-nav.tsx) decorates each href with its icon.

import type { RbacPermissionId } from "@support-agent/dashboard-contracts";

export interface SettingsNavItem {
  readonly href: string;
  readonly label: string;
  /** True when `pathname` should highlight this item. */
  readonly match: (pathname: string) => boolean;
  /**
   * Permission a member needs to SEE this item. Absent → visible to everyone.
   * The api enforces independently; this only hides links the member can't use.
   */
  readonly requires?: RbacPermissionId;
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
      {
        href: "/settings/agents",
        label: "Agents",
        match: prefix("/settings/agents"),
        requires: "settings.agents",
      },
      {
        href: "/settings/permissions",
        label: "Permissions",
        match: prefix("/settings/permissions"),
        requires: "settings.agents",
      },
      {
        href: "/settings/resolution-policy",
        label: "Resolution agent",
        match: prefix("/settings/resolution-policy"),
        requires: "settings.agents",
      },
      {
        href: "/settings/llm",
        label: "AI provider",
        match: prefix("/settings/llm"),
        requires: "settings.llm",
      },
      {
        href: "/settings/refund-policy",
        label: "Refund policy",
        match: prefix("/settings/refund-policy"),
        requires: "settings.refund_policy",
      },
      {
        href: "/settings/discount-policy",
        label: "Discount policy",
        match: prefix("/settings/discount-policy"),
        requires: "settings.refund_policy",
      },
      {
        href: "/settings/knowledge",
        label: "Knowledge base",
        match: prefix("/settings/knowledge"),
        requires: "knowledge.view",
      },
      {
        href: "/settings/usage",
        label: "Usage",
        match: prefix("/settings/usage"),
        requires: "audit.view",
      },
      {
        href: "/settings/members",
        label: "Members",
        match: prefix("/settings/members"),
        requires: "members.manage",
      },
      {
        href: "/settings/suppliers",
        label: "Suppliers",
        match: prefix("/settings/suppliers"),
        requires: "members.manage",
      },
    ],
  },
  {
    label: "Connections",
    items: [
      {
        href: "/settings/notifications",
        label: "Notifications",
        match: prefix("/settings/notifications"),
        requires: "settings.notifications",
      },
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
        requires: "settings.integrations",
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
        requires: "account.manage",
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

/**
 * Filter the settings nav to the items a member may see, dropping any group
 * left empty. An item with no `requires` is always shown; otherwise the
 * member's effective permission set must include it. (The api enforces the
 * real boundary — this only hides links.)
 */
export const visibleSettingsGroups = (
  permissions: ReadonlySet<RbacPermissionId>,
  groups: ReadonlyArray<SettingsNavGroup> = SETTINGS_NAV_GROUPS,
): ReadonlyArray<SettingsNavGroup> =>
  groups
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) => !item.requires || permissions.has(item.requires),
      ),
    }))
    .filter((group) => group.items.length > 0);

/**
 * True when the member holds at least one PERMISSION-GATED settings item — the
 * IconRail uses this to decide whether to show the Settings cog at all. The
 * always-visible Overview/Legal items don't count (a cases-only member has no
 * reason to land in Settings).
 */
export const hasAnySettingsAccess = (
  permissions: ReadonlySet<RbacPermissionId>,
): boolean =>
  SETTINGS_NAV_GROUPS.some((group) =>
    group.items.some(
      (item) => item.requires !== undefined && permissions.has(item.requires),
    ),
  );
