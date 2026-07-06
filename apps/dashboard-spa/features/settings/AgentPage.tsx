import * as React from "react";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { toast } from "sonner";

import type {
  AgentDto,
  AgentOverrideRow,
  CatalogResponse,
  ModelsResponse,
  TenantSettingsView,
} from "@support-agent/dashboard-contracts";
import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { useRequirePermission } from "@/lib/require-permission";
import {
  findAgent,
  tenantConfigurableActions,
  currentToolPermission,
  effectivePermission,
} from "@/lib/catalog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Link } from "@/components/ui/link";
import { ModelCombobox } from "@/components/ui/model-combobox";
import { PermissionToggle } from "@/components/ui/permission-toggle";
import { SettingsBreadcrumb } from "@/components/settings-breadcrumb";

const SCENARIO_AGENT_ID = "scenario-resolution-agent";

const modeVariant = (mode: string): "info" | "secondary" =>
  mode === "primary" ? "info" : "secondary";

const PROVIDER_LABEL: Readonly<Record<string, string>> = {
  openrouter: "OpenRouter",
  anthropic: "Anthropic",
  openai: "OpenAI",
};

const minorToMajor = (minor: number): string => (minor / 100).toFixed(2);

const Row = ({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) => (
  <>
    <dt className="text-[0.6875rem] uppercase tracking-wider text-muted-foreground">
      {label}
    </dt>
    <dd className="text-sm">{children}</dd>
  </>
);

// ---- Built-in agent: read-only cards + model / prompt / permission overrides ----

function BuiltinAgentDetail({
  agent,
  catalog,
  overrideRow,
  models,
  settings,
}: {
  readonly agent: AgentDto;
  readonly catalog: CatalogResponse;
  readonly overrideRow: AgentOverrideRow | null;
  readonly models: ModelsResponse;
  readonly settings: TenantSettingsView;
}) {
  const ctx = useWorkspaceCtx();
  const w = ctx.workspaceId;
  const qc = useQueryClient();

  const override = overrideRow?.model ?? null;
  const systemPromptOverride = overrideRow?.systemPrompt ?? null;
  const effectiveModel = override ?? agent.model;
  // The tenant-configurable outward actions for this agent (reply, refund, …).
  // Internal plumbing tools are filtered out by `tenantConfigurableActions`.
  const actions = tenantConfigurableActions(agent, catalog);
  const refundPolicy = settings.refundPolicy;
  const discountPolicy = settings.discountPolicy;

  // The api resolves the tenant's LLM credential server-side and returns the
  // model list (the decrypted key never reaches the browser).
  const credential = models.connected
    ? { provider: models.provider ?? "" }
    : null;
  const catalogModels = models.entries;
  const catalogError = models.error;

  // Surface a sticky banner if the user has an override that isn't in the
  // current provider's catalog (probably switched providers). We still let
  // them keep it — clearing requires an explicit click — but they should
  // know the picker won't help them re-select it.
  const overrideMissingFromCatalog =
    override !== null &&
    credential !== null &&
    !catalogModels.some((o) => o.id === override);

  // Keep the system-prompt textarea reflecting the saved value: it resyncs
  // whenever the server override changes (after a save or reset).
  const [promptText, setPromptText] = useState(systemPromptOverride ?? "");
  useEffect(() => {
    setPromptText(systemPromptOverride ?? "");
  }, [systemPromptOverride]);

  const invalidateAgents = () => {
    void qc.invalidateQueries({ queryKey: qk.agentOverrides(w) });
    void qc.invalidateQueries({ queryKey: qk.catalog(w) });
  };

  const modelMutation = useMutation({
    mutationFn: async (model: string) => {
      if (model === "" || model === agent.model) {
        await api.clearAgentModel(ctx, agent.id);
        return "reset" as const;
      }
      await api.setAgentModel(ctx, agent.id, model);
      return "updated" as const;
    },
    onSuccess: (outcome) => {
      toast.success(
        outcome === "reset"
          ? "Model reset to the agent default."
          : "Model updated.",
      );
      invalidateAgents();
    },
    onError: () => toast.warning("Something went wrong. Please try again."),
  });

  const clearModelMutation = useMutation({
    mutationFn: () => api.clearAgentModel(ctx, agent.id),
    onSuccess: () => {
      toast.success("Model reset to the agent default.");
      invalidateAgents();
    },
    onError: () => toast.warning("Something went wrong. Please try again."),
  });

  const promptMutation = useMutation({
    mutationFn: async (systemPrompt: string) => {
      // Saving an empty prompt reverts to the built-in prompt (the api treats a
      // blank body as a clear too; we mirror it here so the banner reads "reset").
      if (systemPrompt === "") {
        await api.clearAgentSystemPrompt(ctx, agent.id);
        return "reset" as const;
      }
      await api.setAgentSystemPrompt(ctx, agent.id, systemPrompt);
      return "updated" as const;
    },
    onSuccess: (outcome) => {
      toast.success(
        outcome === "reset"
          ? "System prompt reset to the built-in prompt."
          : "System prompt saved.",
      );
      void qc.invalidateQueries({ queryKey: qk.agentOverrides(w) });
    },
    onError: () => toast.warning("Something went wrong. Please try again."),
  });

  const clearPromptMutation = useMutation({
    mutationFn: () => api.clearAgentSystemPrompt(ctx, agent.id),
    onSuccess: () => {
      toast.success("System prompt reset to the built-in prompt.");
      void qc.invalidateQueries({ queryKey: qk.agentOverrides(w) });
    },
    onError: () => toast.warning("Something went wrong. Please try again."),
  });

  // Set a per-agent tool permission from the Actions card's Ask/Auto toggle.
  // Mirrors the model rule: re-selecting the agent default drops the override
  // instead of storing a redundant row.
  const handleToolPermission = async (fd: FormData) => {
    const toolRaw = fd.get("tool");
    const permRaw = fd.get("permission");
    const tool = typeof toolRaw === "string" ? toolRaw.trim() : "";
    const permission =
      permRaw === "ask" || permRaw === "allow" ? permRaw : null;
    if (!tool || !permission) return;
    const agentDefault = effectivePermission(agent, catalog, tool);
    try {
      if (permission === agentDefault) {
        await api.clearAgentToolPermission(ctx, agent.id, tool);
      } else {
        await api.setAgentToolPermission(ctx, agent.id, tool, permission);
      }
      toast.success("Action permission updated.");
      invalidateAgents();
    } catch {
      toast.warning("Something went wrong. Please try again.");
    }
  };

  const providerName = credential
    ? (PROVIDER_LABEL[credential.provider] ?? credential.provider)
    : "";

  return (
    <div className="space-y-6">
      <SettingsBreadcrumb current="Agent" />

      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Agent</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>{agent.name}</span>
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
            {agent.id}
          </code>
          <Badge variant={modeVariant(agent.mode)}>{agent.mode}</Badge>
        </div>
        <p className="mt-3 text-sm">{agent.description}</p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Model</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid grid-cols-[max-content_1fr] items-center gap-x-4 gap-y-2">
            <Row label="Effective model">
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                {effectiveModel}
              </code>
              {override ? (
                <Badge variant="info" className="ml-2">
                  override
                </Badge>
              ) : (
                <span className="ml-2 text-xs text-muted-foreground">
                  agent default
                </span>
              )}
            </Row>
            <Row label="Agent default">
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                {agent.model}
              </code>
            </Row>
            {agent.fallback ? (
              <Row label="Fallback">
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                  {agent.fallback.provider}:{agent.fallback.model}
                </code>
              </Row>
            ) : null}
          </dl>

          {!credential ? (
            <Alert variant="warning">
              <AlertTriangle className="size-4" />
              <AlertTitle>No AI provider connected</AlertTitle>
              <AlertDescription>
                Connect a provider on{" "}
                <Link
                  href="/settings/llm"
                  className="font-medium text-primary hover:underline"
                >
                  Settings → AI provider
                </Link>{" "}
                before picking per-agent models. The picker shows models from
                the connected provider only.
              </AlertDescription>
            </Alert>
          ) : null}

          {credential && catalogError ? (
            <Alert variant="warning">
              <AlertTriangle className="size-4" />
              <AlertTitle>Model catalog unavailable</AlertTitle>
              <AlertDescription>
                Couldn&apos;t fetch the model list from {providerName}:{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                  {catalogError}
                </code>
                . The agent will keep using the current effective model.
              </AlertDescription>
            </Alert>
          ) : null}

          {overrideMissingFromCatalog ? (
            <Alert variant="warning">
              <AlertTriangle className="size-4" />
              <AlertTitle>Override not in current catalog</AlertTitle>
              <AlertDescription>
                The override{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                  {override}
                </code>{" "}
                isn&apos;t in the connected provider&apos;s catalog — probably
                because the provider was switched. Pick a new model below, or
                reset to the agent default.
              </AlertDescription>
            </Alert>
          ) : null}

          {credential ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const raw = new FormData(e.currentTarget).get("model");
                modelMutation.mutate(typeof raw === "string" ? raw.trim() : "");
              }}
              className="flex items-start gap-2"
            >
              <div className="flex-1">
                <ModelCombobox
                  key={override ?? "__default__"}
                  name="model"
                  value={override ?? ""}
                  defaultModel={agent.model}
                  options={catalogModels}
                  disabled={catalogModels.length === 0}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Models from {providerName}.
                  {catalogModels.length > 0
                    ? ` ${catalogModels.length} models available.`
                    : ""}
                </p>
              </div>
              <Button type="submit" disabled={modelMutation.isPending}>
                Save
              </Button>
            </form>
          ) : null}

          {override ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={clearModelMutation.isPending}
              onClick={() => clearModelMutation.mutate()}
            >
              <RotateCcw className="size-3.5" aria-hidden />
              Reset to default
            </Button>
          ) : null}
        </CardContent>
      </Card>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Permissions</h2>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Actions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <p className="pb-2 text-sm text-muted-foreground">
              Decide which actions this agent does on its own and which wait for
              your approval first.
            </p>
            {actions.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">
                This agent has no customer-facing actions to configure.
              </p>
            ) : (
              <ul className="divide-y">
                {actions.map(({ tool }) => (
                  <li
                    key={tool.name}
                    className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between"
                  >
                    <div className="min-w-0 sm:pr-6">
                      <div className="text-sm font-medium">
                        {tool.displayName ?? tool.name}
                      </div>
                      {tool.displayDescription ? (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {tool.displayDescription}
                        </p>
                      ) : null}
                    </div>
                    <div className="shrink-0">
                      {tool.tenantControl === "refund-threshold" ? (
                        <div className="sm:text-right">
                          <p className="text-xs text-muted-foreground">
                            Auto up to {refundPolicy.currencyCode}{" "}
                            {minorToMajor(refundPolicy.askAboveMinorUnits)} · asks{" "}
                            {minorToMajor(refundPolicy.askAboveMinorUnits)}–
                            {minorToMajor(refundPolicy.denyAboveMinorUnits)} ·
                            blocked above {refundPolicy.currencyCode}{" "}
                            {minorToMajor(refundPolicy.denyAboveMinorUnits)}
                          </p>
                          <Link
                            href="/settings/refund-policy"
                            className="mt-1 inline-block text-xs font-medium text-primary hover:underline"
                          >
                            Manage refund limits →
                          </Link>
                        </div>
                      ) : tool.tenantControl === "discount-threshold" ? (
                        <div className="sm:text-right">
                          <p className="text-xs text-muted-foreground">
                            {discountPolicy.mode === "always_deny"
                              ? "Coupons blocked"
                              : discountPolicy.mode === "always_ask"
                                ? "Every coupon asks"
                                : `Auto up to ${discountPolicy.askAbovePercentage}% · blocked above ${discountPolicy.maxPercentage}%`}
                          </p>
                          <Link
                            href="/settings/discount-policy"
                            className="mt-1 inline-block text-xs font-medium text-primary hover:underline"
                          >
                            Manage discount limits →
                          </Link>
                        </div>
                      ) : (
                        <PermissionToggle
                          action={handleToolPermission}
                          agentId={agent.id}
                          tool={tool.name}
                          label={tool.displayName ?? tool.name}
                          current={
                            currentToolPermission(
                              agent,
                              catalog,
                              overrideRow,
                              tool.name,
                            ) === "allow"
                              ? "allow"
                              : "ask"
                          }
                        />
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">System prompt</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Add your own instructions for this agent — brand voice, policies,
            tone. Your text is <strong>appended</strong> to the built-in prompt,
            so the agent keeps its tools, handoffs, and approval steps. Leave it
            empty to use the built-in prompt only.
          </p>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              promptMutation.mutate(promptText.trim());
            }}
            className="space-y-3"
          >
            <div className="space-y-1.5">
              <Label htmlFor="systemPrompt">Your instructions</Label>
              <Textarea
                id="systemPrompt"
                name="systemPrompt"
                value={promptText}
                onChange={(e) => setPromptText(e.currentTarget.value)}
                placeholder={
                  "e.g. Greet customers warmly and sign off as “The Acme Team.” We offer free returns within 45 days."
                }
                className="min-h-[160px] font-mono text-xs"
              />
            </div>
            <div className="flex items-center gap-2">
              <Button type="submit" disabled={promptMutation.isPending}>
                Save
              </Button>
              {systemPromptOverride ? (
                <Badge variant="info">custom prompt active</Badge>
              ) : (
                <span className="text-xs text-muted-foreground">
                  using built-in prompt
                </span>
              )}
            </div>
          </form>

          {systemPromptOverride ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={clearPromptMutation.isPending}
              onClick={() => clearPromptMutation.mutate()}
            >
              <RotateCcw className="size-3.5" aria-hidden />
              Reset to built-in prompt
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

export function AgentPage() {
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
  const modelsQ = useQuery({
    queryKey: qk.models(w),
    queryFn: () => api.models(ctx),
    enabled: allowed,
  });
  const settingsQ = useQuery({
    queryKey: qk.settings(w),
    queryFn: () => api.settings(ctx),
    enabled: allowed,
  });

  if (!allowed) return null;

  const catalog = catalogQ.data;
  const overrides = overridesQ.data;
  const models = modelsQ.data;
  const settings = settingsQ.data;

  if (
    catalogQ.isLoading ||
    overridesQ.isLoading ||
    modelsQ.isLoading ||
    settingsQ.isLoading ||
    !catalog ||
    !overrides ||
    !models ||
    !settings
  ) {
    return (
      <div className="space-y-6">
        <SettingsBreadcrumb current="Agent" />
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  const agent = findAgent(catalog, SCENARIO_AGENT_ID);
  if (!agent) {
    return (
      <div className="space-y-6">
        <SettingsBreadcrumb current="Agent" />
        <p className="text-sm font-medium">Agent unavailable</p>
      </div>
    );
  }

  const overrideRow = overrides.find((o) => o.agentId === agent.id) ?? null;
  return (
    <BuiltinAgentDetail
      agent={agent}
      catalog={catalog}
      overrideRow={overrideRow}
      models={models}
      settings={settings}
    />
  );
}
