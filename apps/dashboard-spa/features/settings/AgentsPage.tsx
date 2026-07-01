import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { useRequirePermission } from "@/lib/require-permission";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Link } from "@/components/ui/link";
import { SettingsBreadcrumb } from "@/components/settings-breadcrumb";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const modeVariant = (mode: string): "info" | "secondary" =>
  mode === "primary" ? "info" : "secondary";

export function AgentsPage() {
  const allowed = useRequirePermission("settings.agents");
  const ctx = useWorkspaceCtx();
  const w = ctx.workspaceId;

  const catalogQ = useQuery({
    queryKey: qk.catalog(w),
    queryFn: () => api.catalog(ctx),
    enabled: allowed,
  });
  const overridesQ = useQuery({
    queryKey: qk.agentOverrides(w),
    queryFn: () => api.agentOverrides(ctx),
    enabled: allowed,
  });

  if (!allowed) return null;

  const loading = catalogQ.isLoading || overridesQ.isLoading;
  const agents = catalogQ.data?.agents ?? [];
  const overrides = new Map(
    (overridesQ.data ?? []).map((o) => [o.agentId, o.model]),
  );

  return (
    <div className="space-y-6">
      <SettingsBreadcrumb current="Agents" />
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Agents</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {loading
              ? "Loading agents…"
              : `${agents.length} support agent${agents.length === 1 ? "" : "s"} working your cases.`}
          </p>
        </div>
        <Button asChild>
          <Link href="/settings/agents/new">
            <Plus className="size-4" aria-hidden />
            New agent
          </Link>
        </Button>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Mode</TableHead>
              <TableHead>Model</TableHead>
              <TableHead>Tools</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="py-8 text-center text-sm text-muted-foreground"
                >
                  Loading…
                </TableCell>
              </TableRow>
            ) : (
              agents.map((a) => {
                const override = overrides.get(a.id) ?? null;
                const effectiveModel = override ?? a.model;
                return (
                  <TableRow key={a.id}>
                    <TableCell>
                      <span className="inline-flex items-center gap-2">
                        <Link
                          href={`/settings/agents/${a.id}`}
                          className="font-medium text-primary hover:underline"
                        >
                          {a.name}
                        </Link>
                        {a.isCustom ? (
                          <Badge variant="secondary">custom</Badge>
                        ) : null}
                      </span>
                      <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                        {a.id}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={modeVariant(a.mode)}>{a.mode}</Badge>
                    </TableCell>
                    <TableCell>
                      <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                        {effectiveModel}
                      </code>
                      {override ? (
                        <Badge variant="info" className="ml-2">
                          override
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {a.tools.length}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
