import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { findAgent, findTool, effectivePermission } from "@/lib/catalog";
import { permissionVariant } from "@/lib/status-variants";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface Props {
  readonly params: Promise<{ readonly id: string }>;
}

const Row = ({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) => (
  <>
    <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">
      {label}
    </dt>
    <dd className="text-sm">{children}</dd>
  </>
);

const modeVariant = (mode: string): "info" | "secondary" =>
  mode === "primary" ? "info" : "secondary";

export default async function AgentDetailPage({ params }: Props) {
  const { id } = await params;
  const agent = findAgent(id);
  if (!agent) notFound();

  return (
    <div className="space-y-6">
      <Link
        href="/settings/agents"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Agents
      </Link>

      <div>
        <h1 className="text-3xl font-semibold tracking-tight">{agent.name}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
            {agent.id}
          </code>
          <Badge variant={modeVariant(agent.mode)}>{agent.mode}</Badge>
        </div>
        <p className="mt-3 text-sm">{agent.description}</p>
      </div>

      <Card>
        <CardContent className="p-6">
          <dl className="grid grid-cols-[max-content_1fr] items-center gap-x-4 gap-y-2">
            <Row label="Model">
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                {agent.provider}:{agent.model}
              </code>
            </Row>
            {agent.fallback ? (
              <Row label="Fallback">
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                  {agent.fallback.provider}:{agent.fallback.model}
                </code>
              </Row>
            ) : null}
            <Row label="Max turns / tick">{agent.maxTurnsPerTick}</Row>
            {agent.temperature !== undefined ? (
              <Row label="Temperature">{agent.temperature}</Row>
            ) : null}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Tools</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tool</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Permission</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {agent.tools.map((toolName) => {
                const tool = findTool(toolName);
                const perm = effectivePermission(agent, toolName);
                const overridden =
                  agent.permissionOverrides[toolName] !== undefined;
                return (
                  <TableRow key={toolName}>
                    <TableCell>
                      <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                        {toolName}
                      </code>
                      {!tool ? (
                        <div className="mt-0.5 text-xs italic text-muted-foreground">
                          (not in catalog)
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {tool?.description ?? "—"}
                    </TableCell>
                    <TableCell>
                      {perm ? (
                        <Badge variant={permissionVariant(perm)}>{perm}</Badge>
                      ) : (
                        "—"
                      )}
                      {overridden ? (
                        <div className="mt-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                          overridden
                        </div>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {agent.handoffs.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Handoffs</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1">
              {agent.handoffs.map((target) => (
                <li key={target}>
                  <Link
                    href={`/settings/agents/${target}`}
                    className="text-primary hover:underline"
                  >
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                      {target}
                    </code>
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Prompt</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="max-h-[400px] overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-xs">
            {agent.promptTemplate}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}
