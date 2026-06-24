import { AlertTriangle } from "lucide-react";

import type {
  CustomAgentView,
  ToolDto,
} from "@support-agent/dashboard-contracts";
import {
  toolDisplayLabel,
  isGatedTool,
} from "@/lib/catalog";
import { customAgentErrorLabel } from "@/lib/labels";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import { MultiSelect } from "@/components/ui/multi-select";
import { ConfirmSubmitButton } from "@/components/ui/confirm-submit-button";
import {
  ModelCombobox,
  type ModelOption,
} from "@/components/ui/model-combobox";
import {
  createCustomAgentAction,
  deleteCustomAgentAction,
  updateCustomAgentAction,
} from "../custom-actions";

const Field = ({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
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
}: AgentFormProps) => {
  const action =
    mode === "create" ? createCustomAgentAction : updateCustomAgentAction;
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

      <form action={action} className="space-y-6">
        {mode === "edit" && agent ? (
          <input type="hidden" name="agentId" value={agent.agentId} />
        ) : null}

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
              hint="Other agents this one may pass a case to when it's out of scope."
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
              hint="Agents that can hand a case to this one. Usually Support Triage — the agent that sorts new messages."
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
                hint="Disabled agents stay saved but stop handling cases."
              >
                <NativeSelect
                  name="status"
                  defaultValue={agent?.status === "disabled" ? "disabled" : "active"}
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
          <Button type="submit">
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
              Permanently delete this agent. Cases currently handled by it will
              be handed to you.
            </p>
            <form action={deleteCustomAgentAction}>
              <input type="hidden" name="agentId" value={agent.agentId} />
              <ConfirmSubmitButton
                title="Delete this agent?"
                description="This can't be undone. Any case currently on this agent will be handed to you for review."
                confirmLabel="Delete agent"
                size="sm"
              >
                Delete agent
              </ConfirmSubmitButton>
            </form>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
};
