import Link from "next/link";
import {
  Banknote,
  BarChart3,
  Bot,
  ClipboardList,
  FileText,
  KeyRound,
  Plug,
  ShieldCheck,
  Trash2,
} from "lucide-react";

import { api, getDashboardContext } from "@/lib/api-client";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SettingsBreadcrumb } from "@/app/settings/_components/settings-breadcrumb";

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
  {
    href: "/settings/llm",
    icon: KeyRound,
    title: "LLM provider",
    description:
      "Bring your own OpenRouter, Anthropic, or OpenAI key. Required for any agent run.",
  },
  {
    href: "/settings/legal",
    icon: FileText,
    title: "Legal",
    description:
      "Accept the data processing notice and DPA before connecting production providers.",
  },
  {
    href: "/settings/refund-policy",
    icon: Banknote,
    title: "Refund policy",
    description:
      "Amount thresholds that gate refund.create — auto-allow small refunds, ask on mid-range, deny above the cap.",
  },
  {
    href: "/settings/usage",
    icon: BarChart3,
    title: "Usage",
    description:
      "Tenant-wide LLM tokens by day and model with estimated OpenRouter spend.",
  },
  {
    href: "/settings/integrations/google_sheets",
    icon: ClipboardList,
    title: "Supplier escalation",
    description:
      "Google Sheet target for the missing-package agent — configured on the Google Sheets connector. Leave unset to skip the sheet write entirely.",
  },
  {
    href: "/settings/account",
    icon: Trash2,
    title: "Delete account",
    description:
      "Permanently delete this tenant and every record tied to it. This cannot be undone.",
  },
] as const;

export default async function SettingsLanding() {
  const ctx = await getDashboardContext();
  const catalog = await api.catalog(ctx);
  const valueFor = (href: string): string | null => {
    if (href === "/settings/agents") return String(catalog.agents.length);
    if (href === "/settings/permissions") return String(catalog.tools.length);
    if (href === "/settings/llm") return "BYOK";
    if (href === "/settings/legal") return "DPA";
    if (href === "/settings/refund-policy") return "$";
    if (href === "/settings/usage") return "LLM";
    if (href === "/settings/integrations/google_sheets") return "📋";
    return null;
  };

  return (
    <div className="space-y-6">
      <SettingsBreadcrumb current="Settings" />

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
          const value = valueFor(t.href);
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
                  {value ? (
                    <div className="text-2xl font-semibold tabular-nums">
                      {value}
                    </div>
                  ) : null}
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
