import Link from "next/link";
import { AlertTriangle, KeyRound } from "lucide-react";

import { api } from "@/lib/api-client";
import { requirePermission } from "@/lib/require-permission";
import { formatRelativeTime } from "@/lib/format";
import { integrationStatusVariant } from "@/lib/status-variants";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { SubmitButton } from "@/components/ui/submit-button";
import { SettingsBreadcrumb } from "@/app/settings/_components/settings-breadcrumb";

import { connectLlmAction, revokeLlmAction } from "./actions";

const LLM_PROVIDERS = ["openrouter", "anthropic", "openai"] as const;
type LlmProvider = (typeof LLM_PROVIDERS)[number];

const PROVIDER_LABEL: Readonly<Record<LlmProvider, string>> = {
  openrouter: "OpenRouter",
  anthropic: "Anthropic",
  openai: "OpenAI",
};

const PROVIDER_DESCRIPTION: Readonly<Record<LlmProvider, string>> = {
  openrouter:
    "One key that works with every AI model your agents use. Recommended unless you need direct provider billing.",
  anthropic:
    "Direct Anthropic access. Your agents must use Anthropic models (claude-opus-4-7, claude-sonnet-4-6, …).",
  openai:
    "Direct OpenAI access. Your agents must use OpenAI models (gpt-5o, gpt-4o, …).",
};

const isLlmProvider = (p: string): p is LlmProvider =>
  (LLM_PROVIDERS as ReadonlyArray<string>).includes(p);

const compatibleModelsFor = (provider: LlmProvider, model: string): boolean => {
  if (provider === "openrouter") return true;
  if (provider === "anthropic")
    return !model.includes("/") || model.startsWith("anthropic/");
  if (provider === "openai")
    return !model.includes("/") || model.startsWith("openai/");
  return false;
};

interface PageProps {
  readonly searchParams?: Promise<
    Readonly<Record<string, string | string[] | undefined>>
  >;
}

const CredentialForm = ({
  submitLabel,
}: {
  readonly submitLabel: string;
}) => (
  <form action={connectLlmAction} className="space-y-4">
    <div className="grid gap-2">
      <Label htmlFor="provider">Provider</Label>
      <NativeSelect
        id="provider"
        name="provider"
        defaultValue="openrouter"
        required
      >
        {LLM_PROVIDERS.map((p) => (
          <option key={p} value={p}>
            {PROVIDER_LABEL[p]}
          </option>
        ))}
      </NativeSelect>
    </div>
    <div className="grid gap-2">
      <Label htmlFor="apiKey">API key</Label>
      <Input
        id="apiKey"
        name="apiKey"
        type="password"
        autoComplete="off"
        placeholder="sk-or-v1-…"
        required
      />
      <p className="text-xs text-muted-foreground">
        Stored encrypted and used only to run your support agents.
      </p>
    </div>
    <div className="grid gap-2">
      <Label htmlFor="baseURL">Base URL (optional)</Label>
      <Input
        id="baseURL"
        name="baseURL"
        type="url"
        placeholder="https://openrouter.ai/api/v1"
      />
      <p className="text-xs text-muted-foreground">
        Only needed for self-hosted gateways or proxy endpoints.
      </p>
    </div>
    <SubmitButton pendingLabel="Connecting…">{submitLabel}</SubmitButton>
  </form>
);

export default async function LlmSettingsPage({ searchParams }: PageProps) {
  const ctx = await requirePermission("settings.llm");
  const params = (await searchParams) ?? {};
  const connectedBanner =
    (Array.isArray(params["connected"])
      ? params["connected"][0]
      : params["connected"]) === "1";
  const revokedBanner =
    (Array.isArray(params["revoked"])
      ? params["revoked"][0]
      : params["revoked"]) === "1";
  const errorRaw = Array.isArray(params["error"])
    ? params["error"][0]
    : params["error"];

  const [status, catalog] = await Promise.all([
    api.llmStatus(ctx),
    api.catalog(ctx),
  ]);
  const agents = catalog.agents;
  const active = status.effective;
  const activeProvider =
    active && isLlmProvider(active.provider)
      ? (active.provider as LlmProvider)
      : null;

  // Surface model-string compatibility warnings when a direct provider is
  // selected. Agents declaring an unrelated namespace (e.g. `google/...`
  // against an Anthropic-direct key) will hard-fail at the SDK boundary;
  // showing the mismatch here is the operator's only chance to spot it
  // before the first customer message.
  const mismatched = activeProvider
    ? agents.filter((a) => !compatibleModelsFor(activeProvider, a.model))
    : [];

  return (
    <div className="space-y-6">
      <SettingsBreadcrumb current="AI provider" />

      <div>
        <h1 className="text-3xl font-semibold tracking-tight">AI provider</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Bring your own key. Your agents use it for every reply they write —
          we never fall back to a key of our own. Without one, new cases pause
          and wait for you from the first message.
        </p>
      </div>

      {connectedBanner ? (
        <Alert variant="success">
          <AlertDescription>AI provider connected.</AlertDescription>
        </Alert>
      ) : null}
      {revokedBanner ? (
        <Alert variant="success">
          <AlertDescription>AI provider disconnected.</AlertDescription>
        </Alert>
      ) : null}
      {errorRaw === "bad_provider" ? (
        <Alert variant="warning">
          <AlertDescription>
            Unknown provider. Pick one from the list.
          </AlertDescription>
        </Alert>
      ) : null}
      {errorRaw === "missing_key" ? (
        <Alert variant="warning">
          <AlertDescription>
            API key looks empty or too short. Paste the full key.
          </AlertDescription>
        </Alert>
      ) : null}
      {errorRaw === "legal_acceptance_required" ? (
        <Alert variant="warning">
          <AlertDescription>
            Accept the current data processing notice and addendum in{" "}
            <Link
              href="/settings/legal"
              className="font-medium text-primary hover:underline"
            >
              Settings → Legal
            </Link>{" "}
            before connecting an AI provider.
          </AlertDescription>
        </Alert>
      ) : null}
      {errorRaw &&
      !["bad_provider", "missing_key", "legal_acceptance_required"].includes(
        errorRaw,
      ) ? (
        <Alert variant="warning">
          <AlertDescription>
            Something went wrong saving your key. Please try again.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="size-4" aria-hidden />
              {activeProvider
                ? PROVIDER_LABEL[activeProvider]
                : "Not connected"}
            </CardTitle>
            <Badge
              variant={integrationStatusVariant(active ? "active" : "missing")}
            >
              {active ? "active" : "missing"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 pt-0">
          {active ? (
            <>
              <div className="space-y-1 text-sm">
                <div className="text-xs text-muted-foreground">
                  {active.source === "account"
                    ? "Inherited from your account. It applies to every workspace without its own override."
                    : status.workspaceOverride?.updatedAt
                      ? `Workspace override installed ${formatRelativeTime(status.workspaceOverride.updatedAt)}`
                      : "Workspace override active"}
                </div>
              </div>
              {active.source === "workspace" ? (
                <form action={revokeLlmAction}>
                  <SubmitButton variant="outline" pendingLabel="Disconnecting…">
                    Disconnect workspace override
                  </SubmitButton>
                </form>
              ) : (
                <div className="space-y-3 border-t pt-4">
                  <p className="text-sm text-muted-foreground">
                    Add a workspace key below to override the inherited account
                    key for this workspace only.
                  </p>
                  <CredentialForm submitLabel="Set workspace override" />
                </div>
              )}
            </>
          ) : (
            <CredentialForm submitLabel="Connect" />
          )}
        </CardContent>
      </Card>

      {mismatched.length > 0 && activeProvider ? (
        <Alert variant="warning">
          <AlertTriangle className="size-4" />
          <AlertTitle>Model mismatch</AlertTitle>
          <AlertDescription>
            <p>
              Your provider is{" "}
              <strong>{PROVIDER_LABEL[activeProvider]}</strong>, but the
              following agents are set to AI models it can&apos;t serve. Those
              agents won&apos;t be able to respond — their cases will pause and
              wait for you.
            </p>
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm">
              {mismatched.map((a) => (
                <li key={a.id}>
                  <strong>{a.id}</strong>:{" "}
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                    {a.model}
                  </code>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="rounded-md border bg-muted/40 p-4 text-sm text-muted-foreground">
        <p className="mb-2 font-medium text-foreground">Provider notes</p>
        <ul className="list-disc space-y-1 pl-5">
          {LLM_PROVIDERS.map((p) => (
            <li key={p}>
              <strong className="text-foreground">{PROVIDER_LABEL[p]}</strong>:{" "}
              {PROVIDER_DESCRIPTION[p]}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
