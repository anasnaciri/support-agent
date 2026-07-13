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
  /**
   * Sub-items rendered indented beneath this one. An item with children is a
   * section label rather than a link — the children carry the destinations, and
   * `activeSettingsHref` always resolves to a child, never the parent.
   */
  readonly children?: ReadonlyArray<SettingsNavItem>;
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
        href: "/settings/agent",
        label: "Agent",
        match: prefix("/settings/agent"),
        requires: "settings.agents",
      },
      {
        href: "/settings/scenarios",
        label: "Scenarios",
        match: prefix("/settings/scenarios"),
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
        // A section, not a link: the documents and the structured store facts
        // are two different jobs (paste prose vs. state a number the agent acts
        // on), so each gets its own page.
        href: "/settings/knowledge",
        label: "Knowledge base",
        match: (pathname) =>
          prefix("/settings/knowledge")(pathname) ||
          prefix("/settings/facts")(pathname),
        requires: "knowledge.view",
        children: [
          {
            href: "/settings/knowledge",
            label: "Docs",
            match: prefix("/settings/knowledge"),
            requires: "knowledge.view",
          },
          {
            href: "/settings/facts",
            label: "Facts",
            match: prefix("/settings/facts"),
            requires: "knowledge.view",
          },
        ],
      },
      {
        href: "/settings/blocked-senders",
        label: "Blocked senders",
        match: prefix("/settings/blocked-senders"),
        requires: "settings.blocked_senders",
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
        href: "/settings/fulfillment-operators",
        label: "Fulfillment partners",
        match: prefix("/settings/fulfillment-operators"),
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
        // hosts fulfillment partner escalation (reached via Integrations → manage) and
        // its /settings/fulfillment-operator-escalation redirect URL.
        match: (pathname) =>
          pathname === "/settings/integrations" ||
          pathname.startsWith("/settings/integrations/") ||
          pathname === "/settings/fulfillment-operator-escalation" ||
          pathname.startsWith("/settings/fulfillment-operator-escalation/"),
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

/**
 * The href of the nav item that should be highlighted, or null. A child always
 * wins over its parent — the parent is only a label.
 */
export const activeSettingsHref = (pathname: string): string | null => {
  for (const group of SETTINGS_NAV_GROUPS) {
    for (const item of group.items) {
      for (const child of item.children ?? []) {
        if (child.match(pathname)) return child.href;
      }
      if (!item.children && item.match(pathname)) return item.href;
    }
  }
  return null;
};

/**
 * Filter the settings nav to the items a member may see, dropping any group
 * left empty. An item with no `requires` is always shown; otherwise the
 * member's effective permission set must include it. A parent survives only if
 * it keeps at least one visible child. (The api enforces the real boundary —
 * this only hides links.)
 */
export const visibleSettingsGroups = (
  permissions: ReadonlySet<RbacPermissionId>,
  groups: ReadonlyArray<SettingsNavGroup> = SETTINGS_NAV_GROUPS,
): ReadonlyArray<SettingsNavGroup> => {
  const allowed = (item: SettingsNavItem) =>
    !item.requires || permissions.has(item.requires);
  return groups
    .map((group) => ({
      ...group,
      items: group.items
        .filter(allowed)
        .map((item) =>
          item.children
            ? { ...item, children: item.children.filter(allowed) }
            : item,
        )
        .filter((item) => !item.children || item.children.length > 0),
    }))
    .filter((group) => group.items.length > 0);
};

/**
 * True when the member holds at least one PERMISSION-GATED settings item — the
 * IconRail uses this to decide whether to show the Settings cog at all. The
 * always-visible Overview/Legal items don't count (a tickets-only member has no
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
