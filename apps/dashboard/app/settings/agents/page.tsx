import Link from "next/link";

import { api, getDashboardContext } from "@/lib/api-client";
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

const modeVariant = (mode: string): "info" | "secondary" =>
  mode === "primary" ? "info" : "secondary";

export default async function AgentsListPage() {
  const ctx = await getDashboardContext();
  const [catalog, overrideRows] = await Promise.all([
    api.catalog(ctx),
    api.agentOverrides(ctx),
  ]);
  const agents = catalog.agents;
  const overrides = new Map(overrideRows.map((o) => [o.agentId, o.model]));
  return (
    <div className="space-y-6">
      <SettingsBreadcrumb current="Agents" />
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Agents</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {agents.length} agent{agents.length === 1 ? "" : "s"} registered in
          the worker.
        </p>
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
            {agents.map((a) => {
              const override = overrides.get(a.id) ?? null;
              const effectiveModel = override ?? a.model;
              return (
                <TableRow key={a.id}>
                  <TableCell>
                    <Link
                      href={`/settings/agents/${a.id}`}
                      className="font-medium text-primary hover:underline"
                    >
                      {a.name}
                    </Link>
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
            })}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
