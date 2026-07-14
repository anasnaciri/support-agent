import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { findAgent, tenantConfigurableActions } from "@/lib/catalog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Link } from "@/components/ui/link";
import type { WizardStepProps } from "../steps";

// Step 7. The scenario-resolution agent — the one agent on the live path, and
// the one the whole dashboard's Agent page is about.
//
// Read-only here, deliberately. The model default now follows the connected
// provider (so it is already correct), and the per-tool Ask/Auto choices are a
// judgment a merchant can only make once they've seen the agent work. What this
// step owes them is to SHOW the permissions before a single customer sees a
// reply: which actions run on their own, and which wait for approval.

const SCENARIO_AGENT_ID = "scenario-resolution-agent";

export function AgentStep({ onDone }: WizardStepProps) {
  const ctx = useWorkspaceCtx();

  const catalog = useQuery({
    queryKey: qk.catalog(ctx.workspaceId),
    queryFn: () => api.catalog(ctx),
  });

  if (catalog.isLoading) {
    return <Loader2 className="size-5 animate-spin text-muted-foreground" />;
  }

  const data = catalog.data;
  const agent = data ? findAgent(data, SCENARIO_AGENT_ID) : null;
  const actions = data && agent ? tenantConfigurableActions(agent, data) : [];
  const defaultModel = data?.defaultModel ?? null;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Model</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {defaultModel ? (
            <>
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                {defaultModel}
              </code>
              <p className="mt-2 text-sm text-muted-foreground">
                A fast, inexpensive model that suits support work. You can change
                it whenever you like.
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Unavailable until you connect an AI provider.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">What it may do on its own</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <ul className="divide-y">
            {actions.map(({ tool, agentDefault }) => (
              <li
                key={tool.name}
                className="flex items-center justify-between gap-3 py-2.5"
              >
                <span className="min-w-0 truncate text-sm">
                  {tool.displayName ?? tool.name}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {agentDefault === "allow" ? "On its own" : "Asks you first"}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Alert variant="info">
        <AlertTitle>Anything that moves money asks you first</AlertTitle>
        <AlertDescription>
          Refunds, discounts, and cancellations are queued for your approval by
          default, and your refund limits cap them on top of that. You can loosen
          or tighten any of this under{" "}
          <Link
            href="/settings/agent"
            className="font-medium underline underline-offset-4"
          >
            Settings → Agent
          </Link>
          .
        </AlertDescription>
      </Alert>

      <Button onClick={onDone}>Continue</Button>
    </div>
  );
}
