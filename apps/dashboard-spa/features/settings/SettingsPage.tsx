import { useQuery } from "@tanstack/react-query";
import {
  Banknote,
  BarChart3,
  Bot,
  FileText,
  KeyRound,
  Plug,
  ShieldCheck,
  TicketPercent,
  Trash2,
} from "lucide-react";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { Link } from "@/components/ui/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SettingsBreadcrumb } from "@/components/settings-breadcrumb";

const TILES = [
  {
    href: "/settings/agents",
    icon: Bot,
    title: "Agents",
    description:
      "What each agent does, which AI model it uses, and the actions it may take.",
  },
  {
    href: "/settings/permissions",
    icon: ShieldCheck,
    title: "Permissions",
    description:
      "Choose which actions run automatically and which wait for your approval.",
  },
  {
    href: "/settings/integrations",
    icon: Plug,
    title: "Integrations",
    description: "Your store and mailbox connections.",
  },
  {
    href: "/settings/llm",
    icon: KeyRound,
    title: "AI provider",
    description:
      "Bring your own OpenRouter, Anthropic, or OpenAI key. Required for agents to respond.",
  },
  {
    href: "/settings/legal",
    icon: FileText,
    title: "Legal",
    description:
      "Accept the data processing notice and addendum before connecting your accounts.",
  },
  {
    href: "/settings/refund-policy",
    icon: Banknote,
    title: "Refund policy",
    description:
      "Set refund limits — small refunds run automatically, mid-range ask you first, large ones are blocked.",
  },
  {
    href: "/settings/discount-policy",
    icon: TicketPercent,
    title: "Discount policy",
    description:
      "Set limits for goodwill coupon codes — small ones auto-issue, larger ones ask you first or are blocked.",
  },
  {
    href: "/settings/usage",
    icon: BarChart3,
    title: "Usage",
    description: "AI usage by day and model, with estimated spend.",
  },
  {
    href: "/settings/account",
    icon: Trash2,
    title: "Delete account",
    description:
      "Permanently delete this workspace or your whole account. This cannot be undone.",
  },
] as const;

export function SettingsPage() {
  const ctx = useWorkspaceCtx();
  const { data: catalog } = useQuery({
    queryKey: qk.catalog(ctx.workspaceId),
    queryFn: () => api.catalog(ctx),
  });

  const valueFor = (href: string): string | null => {
    if (href === "/settings/agents") {
      return catalog ? String(catalog.agents.length) : null;
    }
    if (href === "/settings/permissions") {
      return catalog ? String(catalog.tools.length) : null;
    }
    if (href === "/settings/llm") return "Key";
    if (href === "/settings/legal") return "Terms";
    if (href === "/settings/refund-policy") return "$";
    if (href === "/settings/discount-policy") return "%";
    if (href === "/settings/usage") return "AI";
    return null;
  };

  return (
    <div className="space-y-6">
      <SettingsBreadcrumb current="Settings" />

      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Tune how your support agents work — what they may do on their own, your
          refund policy, and the accounts they connect to.
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
