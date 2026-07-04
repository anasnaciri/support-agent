import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";

import type { Permission } from "@support-agent/agent-core";
import type {
  CustomAgentView,
  CustomAgentWriteBody,
  ToolDto,
} from "@support-agent/dashboard-contracts";
import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { useRequirePermission } from "@/lib/require-permission";
import { useAppNavigate } from "@/lib/navigation";
import { assignableTools, toolDisplayLabel, isGatedTool } from "@/lib/catalog";
import { customAgentErrorLabel } from "@/lib/labels";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import { MultiSelect } from "@/components/ui/multi-select";
import {
  ModelCombobox,
  type ModelOption,
} from "@/components/ui/model-combobox";
import { ConfirmButton } from "@/features/tickets/ConfirmButton";
import { SettingsBreadcrumb } from "@/components/settings-breadcrumb";

export const DEFAULT_MODEL = "google/gemini-3.5-flash";

// Build a CustomAgentWriteBody from the form. Tools + handoffs arrive as
// repeated keys (MultiSelect renders one hidden input per value); a per-tool
// approval choice arrives as `perm:<tool>` and is kept only for assigned,
// gated tools (read-only tools have no perm field → default automatic).
const parseAgentForm = (formData: FormData): CustomAgentWriteBody => {
  const str = (k: string): string => {
    const v = formData.get(k);
    return typeof v === "string" ? v : "";
  };
  const list = (k: string): ReadonlyArray<string> =>
    formData.getAll(k).filter((v): v is string => typeof v === "string");

  const tools = list("tools");
  const permissionOverrides: Record<string, Permission> = {};
  for (const tool of tools) {
    const p = formData.get(`perm:${tool}`);
    if (p === "ask" || p === "allow") permissionOverrides[tool] = p;
  }

  const turnsRaw = Number(str("maxTurnsPerTick"));
  const maxTurnsPerTick =
    Number.isFinite(turnsRaw) && turnsRaw > 0 ? turnsRaw : 6;
  const status = str("status") === "disabled" ? "disabled" : "active";

  return {
    name: str("name").trim(),
    description: str("description").trim(),
    instructions: str("instructions"),
    model: str("model").trim() || DEFAULT_MODEL,
    tools,
    handoffs: list("handoffs"),
    callableFrom: list("callableFrom"),
    permissionOverrides,
    whenToUse: str("whenToUse").trim() || null,
    maxTurnsPerTick,
    status,
  };
};

const Field = ({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: ReactNode;
}) => (
  <div className="space-y-1.5">
    <Label>{label}</Label>
    {children}
    {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
  </div>
);

interface AgentFormProps {
  readonly mode: "create" | "edit";
  readonly assignable: ReadonlyArray<ToolDto>;
  // Handoff target options: every other agent (built-in + custom), self excluded.
  readonly handoffOptions: ReadonlyArray<{
    readonly label: string;
    readonly value: string;
  }>;
  readonly models: ReadonlyArray<ModelOption>;
  readonly defaultModel: string;
  readonly providerConnected: boolean;
  readonly error?: string | null;
  readonly agent?: CustomAgentView | null;
  readonly onSubmit: (body: CustomAgentWriteBody) => void;
  readonly pending?: boolean;
  readonly onDelete?: () => void;
  readonly deletePending?: boolean;
}

export const AgentForm = ({
  mode,
  assignable,
  handoffOptions,
  models,
  defaultModel,
  providerConnected,
  error,
  agent,
  onSubmit,
  pending,
  onDelete,
  deletePending,
}: AgentFormProps) => {
  const selectedTools = agent?.tools ?? [];
  const selectedHandoffs = agent?.handoffs ?? [];
  const gated = assignable.filter(isGatedTool);
  const toolOptions = assignable.map((t) => ({
    label: toolDisplayLabel(t),
    value: t.name,
  }));

  const permFor = (tool: ToolDto): string =>
    agent?.permissionOverrides[tool.name] ?? tool.defaultPermission;

  return (
    <div className="space-y-6">
      {error ? (
        <Alert variant="warning">
          <AlertTriangle className="size-4" />
          <AlertTitle>Couldn&apos;t save</AlertTitle>
          <AlertDescription>{customAgentErrorLabel(error)}</AlertDescription>
        </Alert>
      ) : null}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(parseAgentForm(new FormData(e.currentTarget)));
        }}
        className="space-y-6"
      >
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Basics</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="Name">
              <Input
                name="name"
                defaultValue={agent?.name ?? ""}
                placeholder="e.g. Returns Concierge"
                maxLength={120}
                required
              />
            </Field>
            <Field
              label="Description"
              hint="A short summary of what this agent handles."
            >
              <Textarea
                name="description"
                defaultValue={agent?.description ?? ""}
                rows={2}
                placeholder="Handles return and exchange requests."
              />
            </Field>
            <Field
              label="Instructions"
              hint="How the agent should behave. Safety + approval rules are added automatically — just describe the job, tone, and policies."
            >
              <Textarea
                name="instructions"
                defaultValue={agent?.instructions ?? ""}
                rows={9}
                placeholder={
                  'e.g. Help customers start a return. Look up the order first. Offer a prepaid label for items within 30 days. Sign off as "The Acme Team."'
                }
              />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Model</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {!providerConnected ? (
              <Alert variant="warning">
                <AlertTriangle className="size-4" />
                <AlertTitle>No AI provider connected</AlertTitle>
                <AlertDescription>
                  Connect a provider on Settings → AI provider to choose a
                  model. Until then the agent uses a default.
                </AlertDescription>
              </Alert>
            ) : null}
            <ModelCombobox
              name="model"
              value={agent?.model ?? ""}
              defaultModel={defaultModel}
              options={models}
              disabled={models.length === 0}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Actions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field
              label="Tools this agent can use"
              hint="Read-only lookups run automatically. Actions that message customers or move money can be set to ask you first below."
            >
              <MultiSelect
                name="tools"
                values={selectedTools}
                options={toolOptions}
                placeholder="Choose tools…"
              />
            </Field>

            {gated.length > 0 ? (
              <div className="space-y-2">
                <Label>Approvals</Label>
                <p className="text-xs text-muted-foreground">
                  For the sensitive actions you assign above, choose whether the
                  agent acts on its own or waits for your approval.
                </p>
                <div className="divide-y rounded-md border">
                  {gated.map((tool) => (
                    <div
                      key={tool.name}
                      className="flex items-center justify-between gap-3 px-3 py-2"
                    >
                      <span className="text-sm">{toolDisplayLabel(tool)}</span>
                      <NativeSelect
                        name={`perm:${tool.name}`}
                        defaultValue={permFor(tool)}
                        className="w-44"
                      >
                        <option value="ask">Ask me first</option>
                        <option value="allow">Automatic</option>
                      </NativeSelect>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <Field
              label="Can hand off to"
              hint="Other agents this one may pass a ticket to when it's out of scope."
            >
              <MultiSelect
                name="handoffs"
                values={selectedHandoffs}
                options={handoffOptions}
                placeholder="No handoffs"
              />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Routing</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field
              label="Reachable from"
              hint="Agents that can hand a ticket to this one. Usually Support Triage — the agent that sorts new messages."
            >
              <MultiSelect
                name="callableFrom"
                values={agent?.callableFrom ?? []}
                options={handoffOptions}
                placeholder="Not reachable by handoff yet"
              />
            </Field>
            <Field
              label="When to use"
              hint="A one-line hint the routing agent sees so it knows when to pick this specialist."
            >
              <Input
                name="whenToUse"
                defaultValue={agent?.whenToUse ?? ""}
                maxLength={200}
                placeholder="e.g. When the customer wants to return or exchange an item."
              />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Advanced</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Max steps per turn"
              hint="How many tool calls the agent may make before pausing."
            >
              <Input
                name="maxTurnsPerTick"
                type="number"
                min={1}
                max={20}
                defaultValue={agent?.maxTurnsPerTick ?? 6}
              />
            </Field>
            {mode === "edit" ? (
              <Field
                label="Status"
                hint="Disabled agents stay saved but stop handling tickets."
              >
                <NativeSelect
                  name="status"
                  defaultValue={
                    agent?.status === "disabled" ? "disabled" : "active"
                  }
                >
                  <option value="active">Active</option>
                  <option value="disabled">Disabled</option>
                </NativeSelect>
              </Field>
            ) : (
              <input type="hidden" name="status" value="active" />
            )}
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button type="submit" disabled={pending}>
            {mode === "create" ? "Create agent" : "Save changes"}
          </Button>
        </div>
      </form>

      {mode === "edit" && agent ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base text-destructive">
              Delete agent
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-3 text-sm text-muted-foreground">
              Permanently delete this agent. Tickets currently handled by it will
              be handed to you.
            </p>
            <ConfirmButton
              title="Delete this agent?"
              description="This can't be undone. Any ticket currently on this agent will be handed to you for review."
              confirmLabel="Delete agent"
              size="sm"
              pending={deletePending ?? false}
              onConfirm={() => onDelete?.()}
            >
              Delete agent
            </ConfirmButton>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
};

export function NewAgentPage() {
  const allowed = useRequirePermission("settings.agents");
  const ctx = useWorkspaceCtx();
  const w = ctx.workspaceId;
  const qc = useQueryClient();
  const nav = useAppNavigate();
  const [saveError, setSaveError] = useState<string | null>(null);

  const catalogQ = useQuery({
    queryKey: qk.catalog(w),
    queryFn: () => api.catalog(ctx),
    enabled: allowed,
  });
  const modelsQ = useQuery({
    queryKey: qk.models(w),
    queryFn: () => api.models(ctx),
    enabled: allowed,
  });

  const createMutation = useMutation({
    mutationFn: (body: CustomAgentWriteBody) => api.createCustomAgent(ctx, body),
    onSuccess: (res) => {
      if (res.status !== 200) {
        setSaveError(
          (res.body as { error?: string } | null)?.error ?? "unknown",
        );
        return;
      }
      setSaveError(null);
      const created = res.body as { agentId: string };
      void qc.invalidateQueries({ queryKey: qk.catalog(w) });
      toast.success("Agent saved.");
      nav.push(`/settings/agents/${created.agentId}`);
    },
    onError: () => toast.warning("Something went wrong. Please try again."),
  });

  if (!allowed) return null;

  const catalog = catalogQ.data ?? null;
  const models = modelsQ.data ?? null;

  if (catalogQ.isLoading || modelsQ.isLoading || !catalog || !models) {
    return (
      <div className="space-y-6">
        <SettingsBreadcrumb
          items={[{ href: "/settings/agents", label: "Agents" }]}
          current="New agent"
        />
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  // Every existing agent (built-in + custom) is a possible handoff target.
  const handoffOptions = catalog.agents.map((a) => ({
    label: a.name,
    value: a.id,
  }));

  return (
    <div className="space-y-6">
      <SettingsBreadcrumb
        items={[{ href: "/settings/agents", label: "Agents" }]}
        current="New agent"
      />
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">New agent</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Build a specialist that handles a specific kind of request. Existing
          agents can hand off to it once it&apos;s live.
        </p>
      </div>
      <AgentForm
        mode="create"
        assignable={assignableTools(catalog)}
        handoffOptions={handoffOptions}
        models={models.entries}
        defaultModel={DEFAULT_MODEL}
        providerConnected={models.connected}
        error={saveError}
        onSubmit={(body) => createMutation.mutate(body)}
        pending={createMutation.isPending}
      />
    </div>
  );
}
