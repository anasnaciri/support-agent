import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AtSign, Globe, ShieldOff } from "lucide-react";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { useRequirePermission } from "@/lib/require-permission";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SettingsBreadcrumb } from "@/components/settings-breadcrumb";

type Ctx = { readonly workspaceId: string };

// Mirror of the server's classification, for the live hint only — the api
// re-classifies and validates authoritatively on add.
const classify = (raw: string): "email" | "domain" | null => {
  const v = raw.trim();
  if (v === "") return null;
  if (v.startsWith("@")) return "domain";
  return v.includes("@") ? "email" : "domain";
};

function RemoveEntryButton({
  kind,
  value,
  ctx,
}: {
  readonly kind: "email" | "domain";
  readonly value: string;
  readonly ctx: Ctx;
}) {
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.removeBlockedSender(ctx, { kind, value }),
    onSuccess: () => {
      toast.success(`Unblocked ${value}.`);
      void qc.invalidateQueries({ queryKey: qk.blockedSenders(ctx.workspaceId) });
    },
    onError: () => {
      toast.warning("Something went wrong. Please try again.");
    },
  });
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={remove.isPending}
      onClick={() => remove.mutate()}
    >
      {remove.isPending ? "Removing…" : "Remove"}
    </Button>
  );
}

function EntryList({
  kind,
  values,
  emptyText,
  ctx,
}: {
  readonly kind: "email" | "domain";
  readonly values: ReadonlyArray<string>;
  readonly emptyText: string;
  readonly ctx: Ctx;
}) {
  if (values.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyText}</p>;
  }
  return (
    <ul className="divide-y divide-border rounded-md border">
      {values.map((value) => (
        <li
          key={value}
          className="flex items-center justify-between gap-3 px-4 py-2.5"
        >
          <span className="min-w-0 truncate font-mono text-sm">{value}</span>
          <RemoveEntryButton kind={kind} value={value} ctx={ctx} />
        </li>
      ))}
    </ul>
  );
}

export function BlockedSendersPage() {
  const allowed = useRequirePermission("settings.blocked_senders");
  const ctx = useWorkspaceCtx();
  const qc = useQueryClient();
  const [value, setValue] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: qk.blockedSenders(ctx.workspaceId),
    queryFn: () => api.blockedSenders(ctx),
    enabled: allowed,
  });

  const add = useMutation({
    mutationFn: (v: string) => api.addBlockedSender(ctx, v),
    onSuccess: (res) => {
      if (res.status !== 200) {
        const err = (res.body as { error?: string } | null)?.error;
        toast.warning(
          err === "list_full"
            ? "This list is full (500 entries). Remove entries before adding more."
            : "Enter an email address or a domain like example.com.",
        );
        return;
      }
      const body = res.body as {
        entry?: { kind: "email" | "domain"; value: string };
        alreadyBlocked?: boolean;
      } | null;
      if (body?.alreadyBlocked) {
        toast.info(`${body.entry?.value ?? "That sender"} is already blocked.`);
      } else if (body?.entry) {
        toast.success(
          body.entry.kind === "email"
            ? `Emails from ${body.entry.value} will no longer open tickets.`
            : `Emails from ${body.entry.value} (and its subdomains) will no longer open tickets.`,
        );
      }
      setValue("");
      void qc.invalidateQueries({ queryKey: qk.blockedSenders(ctx.workspaceId) });
    },
    onError: () => {
      toast.warning("Something went wrong. Please try again.");
    },
  });

  if (!allowed) return null;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim() || add.isPending) return;
    add.mutate(value);
  };

  const kind = classify(value);
  const blocked = data ?? { emails: [], domains: [] };

  return (
    <div className="space-y-6">
      <SettingsBreadcrumb current="Blocked senders" />

      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Blocked senders</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Emails from blocked senders are ignored: they never open tickets and
          never reach your agents. Block a whole domain to stop newsletters and
          marketing blasts, or a single address to stop one spammer without
          blocking everyone on that provider.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldOff className="size-4" aria-hidden />
            Block a sender
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <form onSubmit={onSubmit} className="space-y-3">
            <div className="grid gap-2">
              <Label htmlFor="blocked-sender-value">
                Email address or domain
              </Label>
              <div className="flex gap-2">
                <Input
                  id="blocked-sender-value"
                  name="value"
                  placeholder="spammer@example.com or newsletter.example.com"
                  autoComplete="off"
                  disabled={add.isPending}
                  value={value}
                  onChange={(e) => setValue(e.currentTarget.value)}
                  className="max-w-md"
                />
                <Button type="submit" disabled={add.isPending || !value.trim()}>
                  {add.isPending ? "Blocking…" : "Block"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {kind === "email"
                  ? "Blocks this address only. Other senders on the same domain still get through."
                  : kind === "domain"
                    ? "Blocks every address on this domain, including its subdomains."
                    : "An address blocks one sender; a domain blocks everyone on it."}
              </p>
            </div>
          </form>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Globe className="size-4" aria-hidden />
              Blocked domains
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (
              <EntryList
                kind="domain"
                values={blocked.domains}
                emptyText="No blocked domains."
                ctx={ctx}
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <AtSign className="size-4" aria-hidden />
              Blocked addresses
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (
              <EntryList
                kind="email"
                values={blocked.emails}
                emptyText="No blocked addresses."
                ctx={ctx}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
