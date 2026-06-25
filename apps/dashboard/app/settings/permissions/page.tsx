import Link from "next/link";

import { api } from "@/lib/api-client";
import { requirePermission } from "@/lib/require-permission";
import {
  currentToolPermission,
  merchantConfigurableTools,
} from "@/lib/catalog";
import { permissionVariant } from "@/lib/status-variants";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { SettingsBreadcrumb } from "@/app/settings/_components/settings-breadcrumb";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export default async function PermissionsMatrixPage() {
  const ctx = await requirePermission("settings.agents");
  const [catalog, overrides] = await Promise.all([
    api.catalog(ctx),
    api.agentOverrides(ctx),
  ]);
  const agents = catalog.agents;
  const tools = merchantConfigurableTools(catalog);
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
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Action</TableHead>
              {agents.map((a) => (
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
            {tools.map((t) => (
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
                {agents.map((a) => {
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
      </Card>
    </div>
  );
}
