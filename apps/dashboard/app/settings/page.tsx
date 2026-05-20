import Link from "next/link";
import { Bot, Plug, ShieldCheck } from "lucide-react";

import { agents, tools } from "@/lib/catalog";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const TILES = [
  {
    href: "/settings/agents",
    icon: Bot,
    title: "Agents",
    description: "Prompts, models, tools, and handoffs per agent.",
  },
  {
    href: "/settings/permissions",
    icon: ShieldCheck,
    title: "Tool permissions",
    description: "Allow / ask / deny per (agent, tool) pair.",
  },
  {
    href: "/settings/integrations",
    icon: Plug,
    title: "Integrations",
    description: "Shopify and Gmail connection status for your tenant.",
  },
] as const;

export default function SettingsLanding() {
  const valueFor = (href: string): string => {
    if (href === "/settings/agents") return String(agents.length);
    if (href === "/settings/permissions") return String(tools.length);
    return "—";
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Configuration is currently read-only. Agents and tools live in code
          today; editing surfaces will land when configs move into per-tenant
          rows.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {TILES.map((t) => {
          const Icon = t.icon;
          return (
            <Link
              key={t.href}
              href={t.href}
              className="group block focus-visible:outline-none"
            >
              <Card className="h-full transition-colors group-hover:border-primary group-focus-visible:border-primary group-focus-visible:ring-2 group-focus-visible:ring-ring">
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-2">
                    <span className="flex size-8 items-center justify-center rounded-md bg-primary/15 text-primary">
                      <Icon className="size-4" aria-hidden />
                    </span>
                    <CardTitle>{t.title}</CardTitle>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="text-2xl font-semibold tabular-nums">
                    {valueFor(t.href)}
                  </div>
                  <CardDescription className="mt-1">
                    {t.description}
                  </CardDescription>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
