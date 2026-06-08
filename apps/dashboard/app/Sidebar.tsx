"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  ClipboardCheck,
  Home,
  Inbox,
  LogOut,
  PanelLeftClose,
  Settings,
  Sprout,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

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

const isActive = (pathname: string, href: string): boolean => {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
};

const NavLink = ({
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
      className={cn(
        "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
        active
          ? "bg-sidebar-primary/15 text-sidebar-primary"
          : "text-sidebar-foreground/65 hover:bg-sidebar-accent hover:text-sidebar-foreground",
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className="truncate">{item.label}</span>
    </Link>
  );
};

interface Props {
  readonly email: string | null;
  readonly onToggle: () => void;
}

export function Sidebar({ email, onToggle }: Props) {
  const pathname = usePathname() ?? "/";
  const settingsActive = isActive(pathname, "/settings");

  return (
    <aside className="flex h-screen w-64 flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex items-center justify-between px-4 pb-3 pt-5">
        <Link
          href="/"
          className="flex items-center gap-2 text-sm font-semibold tracking-tight"
        >
          <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Sprout className="size-4" aria-hidden />
          </span>
          Support Agent
        </Link>
        <button
          type="button"
          onClick={onToggle}
          className="flex size-7 items-center justify-center rounded-md text-sidebar-foreground/65 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
          aria-label="Collapse sidebar"
          title="Collapse sidebar"
        >
          <PanelLeftClose className="size-4" aria-hidden />
        </button>
      </div>

      <nav className="flex-1 space-y-0.5 px-2 py-2">
        {PRIMARY_NAV.map((item) => (
          <NavLink
            key={item.href}
            item={item}
            active={isActive(pathname, item.href)}
          />
        ))}
      </nav>

      <div className="space-y-0.5 px-2 pb-2">
        <NavLink
          item={{ href: "/settings", label: "Settings", icon: Settings }}
          active={settingsActive}
        />
      </div>

      <div className="border-t border-sidebar-border px-3 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 text-xs">
            <div className="truncate text-sidebar-foreground/55">
              {email ?? "Not signed in"}
            </div>
          </div>
          <Link
            href="/sign-out"
            prefetch={false}
            className="rounded-md p-1.5 text-sidebar-foreground/65 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
            aria-label="Sign out"
            title="Sign out"
          >
            <LogOut className="size-4" />
          </Link>
        </div>
      </div>
    </aside>
  );
}
