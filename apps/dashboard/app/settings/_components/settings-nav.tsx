"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Banknote,
  BarChart3,
  Bot,
  FileText,
  KeyRound,
  LayoutGrid,
  Library,
  Plug,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

import { SETTINGS_NAV_GROUPS } from "./settings-nav-items";

const ICONS: Record<string, LucideIcon> = {
  "/settings": LayoutGrid,
  "/settings/agents": Bot,
  "/settings/permissions": ShieldCheck,
  "/settings/llm": KeyRound,
  "/settings/refund-policy": Banknote,
  "/settings/knowledge": Library,
  "/settings/usage": BarChart3,
  "/settings/integrations": Plug,
  "/settings/legal": FileText,
  "/settings/account": Trash2,
};

export function SettingsNav() {
  const pathname = usePathname() ?? "/settings";

  return (
    <nav className="flex flex-col gap-5 px-3 pb-6">
      {SETTINGS_NAV_GROUPS.map((group, index) => (
        <div key={group.label ?? `group-${index}`} className="space-y-0.5">
          {group.label ? (
            <p className="px-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {group.label}
            </p>
          ) : null}
          {group.items.map((item) => {
            const Icon = ICONS[item.href] ?? LayoutGrid;
            const active = item.match(pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                  // Active = an elevated neutral surface (depth via shadow, not a
                  // colored indicator), matching the cases sidebar.
                  active
                    ? "bg-card font-medium text-foreground shadow-[0_2px_8px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)] ring-1 ring-black/5 dark:ring-white/10"
                    : "text-foreground/80 hover:bg-accent hover:text-foreground",
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                <span className="truncate">{item.label}</span>
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
