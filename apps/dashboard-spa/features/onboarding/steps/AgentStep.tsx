import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { currentToolPermission, findAgent, tenantConfigurableActions } from "@/lib/catalog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { WizardStepProps } from "../steps";

const SCENARIO_AGENT_ID = "scenario-resolution-agent";

export function AgentStep({ onDone, canEdit }: WizardStepProps) {
  const ctx = useWorkspaceCtx();
  const qc = useQueryClient();
  const catalogQ = useQuery({ queryKey: qk.catalog(ctx.workspaceId), queryFn: () => api.catalog(ctx) });
  const modelsQ = useQuery({ queryKey: qk.models(ctx.workspaceId), queryFn: () => api.models(ctx) });
  const overridesQ = useQuery({ queryKey: qk.agentOverrides(ctx.workspaceId), queryFn: () => api.agentOverrides(ctx) });

  const catalog = catalogQ.data;
  const agent = catalog ? findAgent(catalog, SCENARIO_AGENT_ID) : null;
  const override = overridesQ.data?.find((row) => row.agentId === SCENARIO_AGENT_ID) ?? null;
  const actions = useMemo(() => agent && catalog ? tenantConfigurableActions(agent, catalog) : [], [agent, catalog]);
  const configurable = actions.filter(({ tool }) => tool.tenantControl === "permission-toggle");
  const policyControlled = actions.filter(({ tool }) => tool.tenantControl !== "permission-toggle");
  const [model, setModel] = useState<string | null>(null);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<Readonly<Record<string, "ask" | "allow">>>({});

  useEffect(() => {
    if (!agent || !catalog || model !== null) return;
    setModel(override?.model ?? "");
    setSystemPrompt(override?.systemPrompt ?? "");
    setPermissions(Object.fromEntries(configurable.map(({ tool }) => [
      tool.name,
      currentToolPermission(agent, catalog, override, tool.name) === "allow" ? "allow" : "ask",
    ])));
  }, [agent, catalog, configurable, model, override]);

  const save = useMutation({
    mutationFn: async () => {
      if (!agent || !catalog || model === null || systemPrompt === null) throw new Error("agent unavailable");
      const defaultModel = catalog.defaultModel ?? agent.model;
      if (model !== (override?.model ?? "")) {
        const result = model === "" || model === defaultModel
          ? await api.clearAgentModel(ctx, agent.id)
          : await api.setAgentModel(ctx, agent.id, model);
        if (result.status !== 200) throw new Error("model rejected");
      }
      for (const { tool, agentDefault } of configurable) {
        const next = permissions[tool.name] ?? "ask";
        const current = currentToolPermission(agent, catalog, override, tool.name);
        if (next === current) continue;
        const result = next === agentDefault
          ? await api.clearAgentToolPermission(ctx, agent.id, tool.name)
          : await api.setAgentToolPermission(ctx, agent.id, tool.name, next);
        if (result.status !== 200) throw new Error("permission rejected");
      }
      const nextPrompt = systemPrompt.trim();
      if (nextPrompt !== (override?.systemPrompt ?? "").trim()) {
        const result = nextPrompt
          ? await api.setAgentSystemPrompt(ctx, agent.id, nextPrompt)
          : await api.clearAgentSystemPrompt(ctx, agent.id);
        if (result.status !== 200) throw new Error("instructions rejected");
      }
    },
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.agentOverrides(ctx.workspaceId) }),
        qc.invalidateQueries({ queryKey: qk.catalog(ctx.workspaceId) }),
      ]);
      onDone();
    },
    onError: () => toast.warning("Couldn't save the agent configuration. Please try again."),
  });

  if (catalogQ.isLoading || modelsQ.isLoading || overridesQ.isLoading || !agent || !catalog || model === null || systemPrompt === null) {
    return <Loader2 className="size-5 animate-spin text-muted-foreground" />;
  }

  const models = modelsQ.data;
  const defaultModel = catalog.defaultModel ?? agent.model;
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">Model</CardTitle></CardHeader>
        <CardContent className="space-y-2 pt-0">
          <Label htmlFor="agent-model">Model used for support</Label>
          <NativeSelect id="agent-model" name="model" value={model} onChange={(event) => setModel(event.currentTarget.value)}
            disabled={!canEdit || !models?.connected || (models.entries.length === 0)}>
            <option value="">Default ({defaultModel})</option>
            {(models?.entries ?? []).map((option) => <option key={option.id} value={option.id}>{option.name} ({option.id})</option>)}
          </NativeSelect>
          <p className="text-pretty text-xs text-muted-foreground">
            {models?.connected ? `Models from ${models.provider ?? "your provider"}.` : "Connect an AI provider before choosing a model."}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">Action permissions</CardTitle></CardHeader>
        <CardContent className="space-y-1 pt-0">
          <p className="pb-2 text-pretty text-sm text-muted-foreground">Choose whether each action waits for you or runs automatically.</p>
          <ul className="divide-y">
            {configurable.map(({ tool }) => (
              <li key={tool.name} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div><p className="text-sm font-medium">{tool.displayName ?? tool.name}</p>
                  {tool.displayDescription ? <p className="text-xs text-muted-foreground">{tool.displayDescription}</p> : null}</div>
                <NativeSelect name={`permission:${tool.name}`} value={permissions[tool.name] ?? "ask"} disabled={!canEdit}
                  onChange={(event) => { const next = event.currentTarget.value as "ask" | "allow"; setPermissions((current) => ({ ...current, [tool.name]: next })); }} className="w-48">
                  <option value="ask">Ask me first</option><option value="allow">Run automatically</option>
                </NativeSelect>
              </li>
            ))}
            {policyControlled.map(({ tool }) => (
              <li key={tool.name} className="flex items-center justify-between gap-3 py-3 text-sm">
                <span className="font-medium">{tool.displayName ?? tool.name}</span>
                <span className="text-xs text-muted-foreground">Controlled by refund/discount policy</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">Agent instructions</CardTitle></CardHeader>
        <CardContent className="space-y-2 pt-0">
          <Label htmlFor="agent-instructions">Your instructions</Label>
          <Textarea id="agent-instructions" name="systemPrompt" value={systemPrompt}
            onChange={(event) => setSystemPrompt(event.currentTarget.value)} disabled={!canEdit} rows={5}
            placeholder="For example: Keep replies warm and concise, and sign off as The Acme Team." />
          <p className="text-pretty text-xs text-muted-foreground">These instructions are appended to the built-in safety and workflow prompt.</p>
        </CardContent>
      </Card>

      <Button onClick={() => save.mutate()} disabled={!canEdit || save.isPending}>
        {save.isPending ? "Saving…" : "Save and continue"}
      </Button>
    </div>
  );
}
