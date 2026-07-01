import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { useRequirePermission } from "@/lib/require-permission";
import {
  currentToolPermission,
  merchantConfigurableTools,
} from "@/lib/catalog";
import { permissionVariant } from "@/lib/status-variants";
import { Badge } from "@/components/ui/badge";
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

export function PermissionsPage() {
  const ctx = useWorkspaceCtx();
  const allowed = useRequirePermission("settings.agents");

  const catalogQuery = useQuery({
    queryKey: qk.catalog(ctx.workspaceId),
    queryFn: () => api.catalog(ctx),
    enabled: allowed,
  });
  const overridesQuery = useQuery({
    queryKey: qk.agentOverrides(ctx.workspaceId),
    queryFn: () => api.agentOverrides(ctx),
    enabled: allowed,
  });

  if (!allowed) return null;

  const catalog = catalogQuery.data;
  const overrides = overridesQuery.data ?? [];
  const overrideFor = (agentId: string) =>
    overrides.find((o) => o.agentId === agentId) ?? null;

  return (
    <div className="space-y-6">
      <SettingsBreadcrumb current="Permissions" />

      <div>
        <h1 className="text-3xl font-semibold tracking-tight">
          Permissions
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          What each agent may do on its own, including your changes.{" "}
          <Badge variant={permissionVariant("ask")}>ask</Badge> actions wait
          for your approval before they run.
        </p>
      </div>

      <Card>
        {!catalog || !overridesQuery.data ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            Loading…
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Action</TableHead>
                {catalog.agents.map((a) => (
                  <TableHead key={a.id}>
                    <Link
                      href={`/settings/agents/${a.id}`}
                      className="text-primary hover:underline"
                    >
                      {a.name}
                    </Link>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {merchantConfigurableTools(catalog).map((t) => (
                <TableRow key={t.name}>
                  <TableCell>
                    <div className="text-sm font-medium">
                      {t.displayName ?? t.name}
                    </div>
                    {t.displayDescription ? (
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {t.displayDescription}
                      </div>
                    ) : null}
                  </TableCell>
                  {catalog.agents.map((a) => {
                    if (!a.tools.includes(t.name)) {
                      return (
                        <TableCell key={a.id}>
                          <span className="text-xs text-muted-foreground">
                            —
                          </span>
                        </TableCell>
                      );
                    }
                    if (t.tenantControl === "refund-threshold") {
                      return (
                        <TableCell key={a.id}>
                          <Link
                            href="/settings/refund-policy"
                            className="text-xs font-medium text-primary hover:underline"
                          >
                            refund policy
                          </Link>
                        </TableCell>
                      );
                    }
                    if (t.tenantControl === "discount-threshold") {
                      return (
                        <TableCell key={a.id}>
                          <Link
                            href="/settings/discount-policy"
                            className="text-xs font-medium text-primary hover:underline"
                          >
                            discount policy
                          </Link>
                        </TableCell>
                      );
                    }
                    const eff = currentToolPermission(
                      a,
                      catalog,
                      overrideFor(a.id),
                      t.name,
                    );
                    if (!eff) {
                      return (
                        <TableCell key={a.id}>
                          <Badge variant="muted">?</Badge>
                        </TableCell>
                      );
                    }
                    return (
                      <TableCell key={a.id}>
                        <Badge variant={permissionVariant(eff)}>{eff}</Badge>
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
