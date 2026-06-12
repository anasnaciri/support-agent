"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  ClipboardCheck,
  Home,
  Inbox,
  Settings,
  Sprout,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { WorkspaceSummary } from "@support-agent/dashboard-contracts";

import { cn } from "@/lib/utils";
import { SignOutButton } from "./SignOutButton";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly icon: LucideIcon;
}

const PRIMARY_NAV: ReadonlyArray<NavItem> = [
  { href: "/", label: "Today", icon: Home },
  { href: "/cases", label: "Cases", icon: Inbox },
  { href: "/approvals", label: "Approvals", icon: ClipboardCheck },
  { href: "/audit", label: "Audit", icon: Activity },
];

// Label that fades in as the rail expands on hover. `truncate` (+ flex-1)
// collapses it to zero width when the rail is narrow, so long text never
// spills past the rail into the content area.
const RAIL_LABEL =
  "min-w-0 flex-1 truncate text-sm font-medium opacity-0 transition-opacity duration-200 group-hover/rail:opacity-100";

const isActive = (pathname: string, href: string): boolean => {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
};

const RailLink = ({
  item,
  active,
}: {
  readonly item: NavItem;
  readonly active: boolean;
}) => {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      title={item.label}
      aria-label={item.label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-10 w-full items-center gap-3 rounded-lg transition-colors",
        active
          ? "bg-white/10 text-sidebar-foreground"
          : "text-sidebar-foreground/55 hover:bg-white/5 hover:text-sidebar-foreground",
      )}
    >
      <span className="flex size-10 shrink-0 items-center justify-center">
        <Icon className="size-5" aria-hidden />
      </span>
      <span className={RAIL_LABEL}>{item.label}</span>
    </Link>
  );
};

interface Props {
  readonly email: string | null;
  /** Workspaces for the switcher; null → signed out / pre-onboarding. */
  readonly workspaces: ReadonlyArray<WorkspaceSummary> | null;
  readonly activeWorkspaceId: string | null;
}

export function IconRail({ email, workspaces, activeWorkspaceId }: Props) {
  const pathname = usePathname() ?? "/";
  // Owned here (not in SignOutButton) so the rail can clear the confirmation
  // when the pointer leaves — it hides together with the collapsing rail.
  const [signOutOpen, setSignOutOpen] = useState(false);

  const activeWorkspace =
    workspaces && activeWorkspaceId
      ? (workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0])
      : null;

  return (
    // The 64px spacer holds the column in the layout flow; the rail itself is
    // absolutely positioned so that expanding on hover overlays the content
    // rather than reflowing the whole app.
    <div className="relative w-16 shrink-0">
      <aside
        onMouseLeave={() => setSignOutOpen(false)}
        className="group/rail absolute inset-y-0 left-0 z-40 flex w-16 flex-col items-stretch bg-sidebar px-3 py-4 text-sidebar-foreground transition-[width,box-shadow] duration-200 ease-in-out hover:w-60 hover:shadow-[6px_0_28px_-12px_rgba(0,0,0,0.55)]"
      >
        <Link
          href="/"
          title="Support Agent"
          aria-label="Support Agent home"
          className="flex h-10 w-full items-center gap-3 rounded-lg"
        >
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Sprout className="size-5" aria-hidden />
          </span>
          <span className={cn(RAIL_LABEL, "font-semibold")}>Support Agent</span>
        </Link>

        {workspaces && workspaces.length > 0 && activeWorkspace ? (
          <div className="mt-3 flex w-full items-center gap-3">
            <WorkspaceSwitcher
              workspaces={workspaces}
              activeWorkspaceId={activeWorkspace.id}
            />
            <span className={RAIL_LABEL}>{activeWorkspace.name}</span>
          </div>
        ) : null}

        <nav className="mt-6 flex flex-1 flex-col gap-1">
          {PRIMARY_NAV.map((item) => (
            <RailLink
              key={item.href}
              item={item}
              active={isActive(pathname, item.href)}
            />
          ))}
        </nav>

        <div className="flex flex-col gap-1">
          <RailLink
            item={{ href: "/settings", label: "Settings", icon: Settings }}
            active={isActive(pathname, "/settings")}
          />
          <SignOutButton
            email={email}
            labelClassName={RAIL_LABEL}
            open={signOutOpen}
            onOpenChange={setSignOutOpen}
          />
        </div>
      </aside>
    </div>
  );
}
