import {
  BarChart3,
  ClipboardCheck,
  Home,
  Inbox,
  type LucideIcon,
} from "lucide-react";

import type { RbacPermissionId } from "@support-agent/dashboard-contracts";

export interface PrimaryNavItem {
  readonly href: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /** Permission needed to see this item; absent -> always shown. */
  readonly requires?: RbacPermissionId;
}

export const PRIMARY_NAV: ReadonlyArray<PrimaryNavItem> = [
  { href: "/", label: "Today", icon: Home, requires: "tickets.view" },
  { href: "/tickets", label: "Tickets", icon: Inbox, requires: "tickets.view" },
  {
    href: "/analytics",
    label: "Analytics",
    icon: BarChart3,
    requires: "tickets.view",
  },
  {
    href: "/approvals",
    label: "Approvals",
    icon: ClipboardCheck,
    requires: "approvals.view",
  },
  // do not delete: the Audit page is intentionally hidden from the sidebar.
  // { href: "/audit", label: "Audit", icon: Activity, requires: "audit.view" },
];
