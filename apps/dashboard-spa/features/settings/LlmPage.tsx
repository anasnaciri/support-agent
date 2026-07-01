import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, KeyRound } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { useRequirePermission } from "@/lib/require-permission";
import { LegalRequiredError, NoTenantError } from "@/lib/errors";
import { formatRelativeTime } from "@/lib/format";
import { integrationStatusVariant } from "@/lib/status-variants";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { SettingsBreadcrumb } from "@/components/settings-breadcrumb";

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

interface ConnectInput {
  readonly provider: string;
  readonly apiKey: string;
  readonly baseURL?: string;
}

const CredentialForm = ({
  submitLabel,
  onConnect,
  pending,
}: {
  readonly submitLabel: string;
  readonly onConnect: (input: {
    readonly provider: string;
    readonly apiKey: string;
    readonly baseURL: string;
  }) => void;
  readonly pending: boolean;
}) => {
  // Keep the fields controlled and never reset them on error — a rejected key
  // should leave what the merchant typed exactly where it was.
  const [provider, setProvider] = useState<LlmProvider>("openrouter");
  const [apiKey, setApiKey] = useState("");
  const [baseURL, setBaseURL] = useState("");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onConnect({ provider, apiKey, baseURL });
      }}
      className="space-y-4"
    >
      <div className="grid gap-2">
        <Label htmlFor="provider">Provider</Label>
        <NativeSelect
          id="provider"
          name="provider"
          value={provider}
          onChange={(e) => {
            const next = e.currentTarget.value;
            if (isLlmProvider(next)) setProvider(next);
          }}
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
          value={apiKey}
          onChange={(e) => setApiKey(e.currentTarget.value)}
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
          value={baseURL}
          onChange={(e) => setBaseURL(e.currentTarget.value)}
        />
        <p className="text-xs text-muted-foreground">
          Only needed for self-hosted gateways or proxy endpoints.
        </p>
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Connecting…" : submitLabel}
      </Button>
    </form>
  );
};

export function LlmPage() {
  const ctx = useWorkspaceCtx();
  const qc = useQueryClient();
  const allowed = useRequirePermission("settings.llm");

  const statusQuery = useQuery({
    queryKey: qk.llm(ctx.workspaceId),
    queryFn: () => api.llmStatus(ctx),
    enabled: allowed,
  });

  const catalogQuery = useQuery({
    queryKey: qk.catalog(ctx.workspaceId),
    queryFn: () => api.catalog(ctx),
    enabled: allowed,
  });

  const connectM = useMutation({
    mutationFn: (input: ConnectInput) => api.connectLlm(ctx, input),
    onSuccess: (res) => {
      if (res.status === 200) {
        toast.success("AI provider connected.");
        // Mirrors the action's revalidatePath("/settings/llm") +
        // revalidatePath("/settings/integrations").
        void qc.invalidateQueries({ queryKey: qk.llm(ctx.workspaceId) });
        void qc.invalidateQueries({
          queryKey: qk.connections(ctx.workspaceId),
        });
        return;
      }
      // A 400 defaults to bad_provider (as the reference action does); anything
      // else the page couldn't name falls to the generic save-failed copy.
      const err =
        (res.body as { error?: string } | null)?.error ??
        (res.status === 400 ? "bad_provider" : "");
      if (err === "bad_provider") {
        toast.warning("Unknown provider. Pick one from the list.");
      } else if (err === "missing_key") {
        toast.warning("API key looks empty or too short. Paste the full key.");
      } else {
        toast.warning("Something went wrong saving your key. Please try again.");
      }
    },
    onError: (e) => {
      // A 403 legal_acceptance_required throws LegalRequiredError; the global
      // handler routes to /settings/legal (the Next page's "go to Legal"
      // banner). No-tenant is likewise routed globally. Don't double-toast.
      if (e instanceof LegalRequiredError || e instanceof NoTenantError) return;
      toast.warning("Something went wrong saving your key. Please try again.");
    },
  });

  const revokeM = useMutation({
    mutationFn: () => api.revokeLlm(ctx),
    onSuccess: () => {
      toast.success("AI provider disconnected.");
      void qc.invalidateQueries({ queryKey: qk.llm(ctx.workspaceId) });
      void qc.invalidateQueries({ queryKey: qk.connections(ctx.workspaceId) });
    },
    onError: (e) => {
      if (e instanceof LegalRequiredError || e instanceof NoTenantError) return;
      toast.warning("Something went wrong. Please try again.");
    },
  });

  const handleConnect = (raw: {
    readonly provider: string;
    readonly apiKey: string;
    readonly baseURL: string;
  }): void => {
    const provider = raw.provider.trim();
    const apiKey = raw.apiKey.trim();
    const baseURL = raw.baseURL.trim();
    // Client-side mirror of the action's pre-redirect validation.
    if (!isLlmProvider(provider)) {
      toast.warning("Unknown provider. Pick one from the list.");
      return;
    }
    if (apiKey.length < 8) {
      toast.warning("API key looks empty or too short. Paste the full key.");
      return;
    }
    connectM.mutate({
      provider,
      apiKey,
      ...(baseURL.length > 0 ? { baseURL } : {}),
    });
  };

  if (!allowed) return null;

  const status = statusQuery.data;
  const agents = catalogQuery.data?.agents ?? [];
  const active = status?.effective ?? null;
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

      {statusQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
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
                  variant={integrationStatusVariant(
                    active ? "active" : "missing",
                  )}
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
                        : status?.workspaceOverride?.updatedAt
                          ? `Workspace override installed ${formatRelativeTime(status.workspaceOverride.updatedAt)}`
                          : "Workspace override active"}
                    </div>
                  </div>
                  {active.source === "workspace" ? (
                    <Button
                      variant="outline"
                      disabled={revokeM.isPending}
                      onClick={() => revokeM.mutate()}
                    >
                      {revokeM.isPending
                        ? "Disconnecting…"
                        : "Disconnect workspace override"}
                    </Button>
                  ) : (
                    <div className="space-y-3 border-t pt-4">
                      <p className="text-sm text-muted-foreground">
                        Add a workspace key below to override the inherited
                        account key for this workspace only.
                      </p>
                      <CredentialForm
                        submitLabel="Set workspace override"
                        onConnect={handleConnect}
                        pending={connectM.isPending}
                      />
                    </div>
                  )}
                </>
              ) : (
                <CredentialForm
                  submitLabel="Connect"
                  onConnect={handleConnect}
                  pending={connectM.isPending}
                />
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
                  following agents are set to AI models it can&apos;t serve.
                  Those agents won&apos;t be able to respond — their cases will
                  pause and wait for you.
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
        </>
      )}

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
