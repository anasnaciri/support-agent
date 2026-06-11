import Link from "next/link";
import { AlertTriangle, KeyRound } from "lucide-react";

import { api, getDashboardContext } from "@/lib/api-client";
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
    "Single key that fronts every model your agents request (anthropic/*, google/*, openai/*, …). Recommended unless you need direct provider billing.",
  anthropic:
    "Native Anthropic API. Your agents' model strings must be Anthropic ids (claude-opus-4-7, claude-sonnet-4-6, …).",
  openai:
    "Native OpenAI API. Your agents' model strings must be OpenAI ids (gpt-5o, gpt-4o, …).",
};

const isLlmProvider = (p: string): p is LlmProvider =>
  (LLM_PROVIDERS as ReadonlyArray<string>).includes(p);

const maskKey = (key: string): string => {
  if (key.length <= 8) return "•".repeat(key.length);
  return `${key.slice(0, 4)}${"•".repeat(Math.max(4, key.length - 8))}${key.slice(-4)}`;
};

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

export default async function LlmSettingsPage({ searchParams }: PageProps) {
  const ctx = await getDashboardContext();
  const tenantId = ctx.tenantId;
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

  // We only need the LLM-provider rows. The connections endpoint returns all
  // of the tenant's connector rows; filter to LLM providers here.
  const [rows, catalog] = await Promise.all([
    api.connections(ctx),
    api.catalog(ctx),
  ]);
  const agents = catalog.agents;

  const llmRows = rows.filter((r) => isLlmProvider(r.provider));
  const active = llmRows.find((r) => r.status === "active");
  const activeProvider = active ? (active.provider as LlmProvider) : null;

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
      <SettingsBreadcrumb current="LLM provider" />

      <div>
        <h1 className="text-3xl font-semibold tracking-tight">LLM provider</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Bring your own key. Every agent run on your tenant uses the credential
          below — the platform never falls back to its own key. Without an
          active row, cases park in{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
            human_takeover
          </code>{" "}
          at the first message.
        </p>
      </div>

      {connectedBanner ? (
        <Alert variant="success">
          <AlertDescription>LLM provider connected.</AlertDescription>
        </Alert>
      ) : null}
      {revokedBanner ? (
        <Alert variant="success">
          <AlertDescription>LLM provider revoked.</AlertDescription>
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
            Accept the current data processing notice and DPA in{" "}
            <Link
              href="/settings/legal"
              className="font-medium text-primary hover:underline"
            >
              Settings → Legal
            </Link>{" "}
            before connecting an LLM provider.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="size-4" aria-hidden />
              {active
                ? PROVIDER_LABEL[active.provider as LlmProvider]
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
                <div>
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                    {/* The decrypted key isn't loaded here — only the row's
                        metadata is. Render a placeholder mask using the
                        shopDomain (always "default" for LLM rows) so the
                        operator sees the row exists without leaking the key. */}
                    {maskKey(`••••${active.id.slice(0, 4)}••••`)}
                  </code>
                </div>
                {typeof active.metadata === "object" &&
                active.metadata !== null &&
                typeof (active.metadata as { baseURL?: unknown }).baseURL ===
                  "string" ? (
                  <div className="text-xs text-muted-foreground">
                    Base URL:{" "}
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                      {String((active.metadata as { baseURL: string }).baseURL)}
                    </code>
                  </div>
                ) : null}
                <div className="text-xs text-muted-foreground">
                  {active.installedAt
                    ? `Installed ${formatRelativeTime(active.installedAt)}`
                    : "Installed"}
                </div>
              </div>
              <form action={revokeLlmAction}>
                <SubmitButton variant="outline" pendingLabel="Revoking…">
                  Revoke
                </SubmitButton>
              </form>
            </>
          ) : (
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
                  Stored encrypted (AES-256-GCM) in{" "}
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                    connector_connections
                  </code>
                  . Tenant {tenantId.slice(0, 8)}…
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
              <SubmitButton pendingLabel="Connecting…">Connect</SubmitButton>
            </form>
          )}
        </CardContent>
      </Card>

      {mismatched.length > 0 && activeProvider ? (
        <Alert variant="warning">
          <AlertTriangle className="size-4" />
          <AlertTitle>Model mismatch</AlertTitle>
          <AlertDescription>
            <p>
              Your active provider is{" "}
              <strong>{PROVIDER_LABEL[activeProvider]}</strong>, but the
              following agents declare model ids that won&apos;t resolve through
              it. Those agents will fail at the first LLM call and their cases
              will park in{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                human_takeover
              </code>
              .
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
