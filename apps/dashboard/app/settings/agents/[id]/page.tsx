import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, RotateCcw } from "lucide-react";

import { api } from "@/lib/api-client";
import { requirePermission } from "@/lib/require-permission";
import {
  findAgent,
  tenantConfigurableActions,
  currentToolPermission,
  assignableTools,
} from "@/lib/catalog";
import { resolveFeedback, type FeedbackRule } from "@/lib/toast-feedback";
import { AgentForm } from "../_components/agent-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { FeedbackToaster } from "@/components/ui/feedback-toaster";
import { SettingsBreadcrumb } from "@/app/settings/_components/settings-breadcrumb";
import {
  ModelCombobox,
  type ModelOption,
} from "@/components/ui/model-combobox";
import { PermissionToggle } from "@/components/ui/permission-toggle";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  clearAgentModelAction,
  clearAgentSystemPromptAction,
  setAgentModelAction,
  setAgentSystemPromptAction,
  setAgentToolPermissionAction,
} from "./actions";
import { AgentSwitcher } from "./agent-switcher";
import { agentSwitcherOptions } from "./agent-switcher-data";

interface Props {
  readonly params: Promise<{ readonly id: string }>;
  readonly searchParams?: Promise<
    Readonly<Record<string, string | string[] | undefined>>
  >;
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

const PROVIDER_LABEL: Readonly<Record<string, string>> = {
  openrouter: "OpenRouter",
  anthropic: "Anthropic",
  openai: "OpenAI",
};

const minorToMajor = (minor: number): string => (minor / 100).toFixed(2);

const CUSTOM_AGENT_FEEDBACK: readonly FeedbackRule[] = [
  { param: "saved", kind: "success", message: "Agent saved." },
  { param: "created", kind: "success", message: "Agent saved." },
];

const BUILTIN_AGENT_FEEDBACK: readonly FeedbackRule[] = [
  { param: "model", match: "updated", kind: "success", message: "Model updated." },
  {
    param: "model",
    match: "reset",
    kind: "success",
    message: "Model reset to the agent default.",
  },
  {
    param: "prompt",
    match: "updated",
    kind: "success",
    message: "System prompt saved.",
  },
  {
    param: "prompt",
    match: "reset",
    kind: "success",
    message: "System prompt reset to the built-in prompt.",
  },
  {
    param: "perm",
    match: "updated",
    kind: "success",
    message: "Action permission updated.",
  },
];

export default async function AgentDetailPage({ params, searchParams }: Props) {
  const { id } = await params;
  const ctx = await requirePermission("settings.agents");
  const [catalogResp, overrideRows, models, settings] = await Promise.all([
    api.catalog(ctx),
    api.agentOverrides(ctx),
    api.models(ctx),
    api.settings(ctx),
  ]);
  const agent = findAgent(catalogResp, id);
  if (!agent) notFound();

  const sp = (await searchParams) ?? {};

  // Custom (merchant-authored) agents render the editable form, not the
  // read-only built-in cards. GET-by-id returns the raw instructions to prefill.
  if (agent.isCustom) {
    const view = await api.getCustomAgent(ctx, id);
    if (!view) notFound();
    const err = Array.isArray(sp["error"]) ? sp["error"][0] : sp["error"];
    const customFeedback = resolveFeedback(sp, CUSTOM_AGENT_FEEDBACK);
    const handoffOptions = catalogResp.agents
      .filter((a) => a.id !== id)
      .map((a) => ({ label: a.name, value: a.id }));
    return (
      <div className="space-y-6">
        <SettingsBreadcrumb
          items={[{ href: "/settings/agents", label: "Agents" }]}
          current={view.name}
        />
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{view.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">Custom agent</p>
        </div>
        <FeedbackToaster
          toasts={customFeedback.toasts}
          consume={customFeedback.consume}
        />
        <AgentForm
          mode="edit"
          agent={view}
          assignable={assignableTools(catalogResp)}
          handoffOptions={handoffOptions}
          models={models.entries}
          defaultModel={view.model || "google/gemini-3.5-flash"}
          providerConnected={models.connected}
          error={err ?? null}
        />
      </div>
    );
  }

  const feedback = resolveFeedback(sp, BUILTIN_AGENT_FEEDBACK);

  const overrideRow = overrideRows.find((o) => o.agentId === agent.id) ?? null;
  const override = overrideRow?.model ?? null;
  const systemPromptOverride = overrideRow?.systemPrompt ?? null;
  const effectiveModel = override ?? agent.model;
  // The tenant-configurable outward actions for this agent (reply, refund, …).
  // Internal plumbing tools are filtered out by `tenantConfigurableActions`.
  const actions = tenantConfigurableActions(agent, catalogResp);
  const refundPolicy = settings.refundPolicy;
  const discountPolicy = settings.discountPolicy;

  // The api resolves the tenant's LLM credential server-side and returns the
  // model list (the decrypted key never reaches the browser).
  const credential = models.connected ? { provider: models.provider ?? "" } : null;
  const catalog: ReadonlyArray<ModelOption> = models.entries;
  const catalogError: string | null = models.error;

  // Surface a sticky banner if the user has an override that isn't in the
  // current provider's catalog (probably switched providers). We still let
  // them keep it — clearing requires an explicit click — but they should
  // know the picker won't help them re-select it.
  const overrideMissingFromCatalog =
    override !== null &&
    credential !== null &&
    !catalog.some((o) => o.id === override);

  return (
    <div className="space-y-6">
      <SettingsBreadcrumb
        items={[{ href: "/settings/agents", label: "Agents" }]}
        current={agent.name}
      />

      <div>
        <AgentSwitcher
          options={agentSwitcherOptions(catalogResp.agents, agent.id)}
          currentName={agent.name}
        />
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
            {agent.id}
          </code>
          <Badge variant={modeVariant(agent.mode)}>{agent.mode}</Badge>
        </div>
        <p className="mt-3 text-sm">{agent.description}</p>
      </div>

      <FeedbackToaster toasts={feedback.toasts} consume={feedback.consume} />

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
                Couldn&apos;t fetch the model list from{" "}
                {PROVIDER_LABEL[credential.provider] ?? credential.provider}:{" "}
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
                isn&apos;t in the connected provider&apos;s catalog —
                probably because the provider was switched. Pick a new model
                below, or reset to the agent default.
              </AlertDescription>
            </Alert>
          ) : null}

          {credential ? (
            <form
              action={setAgentModelAction}
              className="flex items-start gap-2"
            >
              <input type="hidden" name="agentId" value={agent.id} />
              <div className="flex-1">
                <ModelCombobox
                  name="model"
                  value={override ?? ""}
                  defaultModel={agent.model}
                  options={catalog}
                  disabled={catalog.length === 0}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Models from{" "}
                  {PROVIDER_LABEL[credential.provider] ?? credential.provider}.
                  {catalog.length > 0
                    ? ` ${catalog.length} models available.`
                    : ""}
                </p>
              </div>
              <Button type="submit">Save</Button>
            </form>
          ) : null}

          {override ? (
            <form action={clearAgentModelAction}>
              <input type="hidden" name="agentId" value={agent.id} />
              <Button type="submit" variant="outline" size="sm">
                <RotateCcw className="size-3.5" aria-hidden />
                Reset to default
              </Button>
            </form>
          ) : null}
        </CardContent>
      </Card>

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
                        action={setAgentToolPermissionAction}
                        agentId={agent.id}
                        tool={tool.name}
                        label={tool.displayName ?? tool.name}
                        current={
                          currentToolPermission(
                            agent,
                            catalogResp,
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

          <form action={setAgentSystemPromptAction} className="space-y-3">
            <input type="hidden" name="agentId" value={agent.id} />
            <div className="space-y-1.5">
              <Label htmlFor="systemPrompt">Your instructions</Label>
              <Textarea
                id="systemPrompt"
                name="systemPrompt"
                defaultValue={systemPromptOverride ?? ""}
                placeholder={
                  "e.g. Greet customers warmly and sign off as “The Acme Team.” We offer free returns within 45 days."
                }
                className="min-h-[160px] font-mono text-xs"
              />
            </div>
            <div className="flex items-center gap-2">
              <Button type="submit">Save</Button>
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
            <form action={clearAgentSystemPromptAction}>
              <input type="hidden" name="agentId" value={agent.id} />
              <Button type="submit" variant="outline" size="sm">
                <RotateCcw className="size-3.5" aria-hidden />
                Reset to built-in prompt
              </Button>
            </form>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
