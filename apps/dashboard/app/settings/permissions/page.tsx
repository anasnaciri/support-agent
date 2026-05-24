import Link from "next/link";

import { agents, tools, effectivePermission } from "@/lib/catalog";
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

export default function PermissionsMatrixPage() {
  return (
    <div className="space-y-6">
      <SettingsBreadcrumb current="Tool permissions" />

      <div>
        <h1 className="text-3xl font-semibold tracking-tight">
          Tool permissions
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Effective permission per (agent, tool).{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">ask</code>{" "}
          tools pause the case in{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
            waiting_for_approval
          </code>{" "}
          until a human approves via the approval surface.
        </p>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tool</TableHead>
              <TableHead>Default</TableHead>
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
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                    {t.name}
                  </code>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {t.description}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant={permissionVariant(t.defaultPermission)}>
                    {t.defaultPermission}
                  </Badge>
                </TableCell>
                {agents.map((a) => {
                  const eff = effectivePermission(a, t.name);
                  const inToolList = a.tools.includes(t.name);
                  if (!inToolList) {
                    return (
                      <TableCell key={a.id}>
                        <span className="text-xs text-muted-foreground">
                          —
                        </span>
                      </TableCell>
                    );
                  }
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
