"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  ClipboardCheck,
  Home,
  Inbox,
  LogOut,
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
        "flex size-10 items-center justify-center rounded-lg transition-colors",
        active
          ? "bg-white/10 text-sidebar-foreground"
          : "text-sidebar-foreground/55 hover:bg-white/5 hover:text-sidebar-foreground",
      )}
    >
      <Icon className="size-5" aria-hidden />
    </Link>
  );
};

interface Props {
  readonly email: string | null;
}

export function IconRail({ email }: Props) {
  const pathname = usePathname() ?? "/";

  return (
    <aside className="flex h-screen w-16 shrink-0 flex-col items-center bg-sidebar py-4 text-sidebar-foreground">
      <Link
        href="/"
        title="Support Agent"
        aria-label="Support Agent home"
        className="flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground"
      >
        <Sprout className="size-5" aria-hidden />
      </Link>

      <nav className="mt-6 flex flex-1 flex-col items-center gap-1">
        {PRIMARY_NAV.map((item) => (
          <RailLink
            key={item.href}
            item={item}
            active={isActive(pathname, item.href)}
          />
        ))}
      </nav>

      <div className="flex flex-col items-center gap-1">
        <RailLink
          item={{ href: "/settings", label: "Settings", icon: Settings }}
          active={isActive(pathname, "/settings")}
        />
        <Link
          href="/sign-out"
          prefetch={false}
          title={email ? `Sign out — ${email}` : "Sign out"}
          aria-label="Sign out"
          className="flex size-10 items-center justify-center rounded-lg text-sidebar-foreground/55 transition-colors hover:bg-white/5 hover:text-sidebar-foreground"
        >
          <LogOut className="size-5" aria-hidden />
        </Link>
      </div>
    </aside>
  );
}
