import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, KeyRound, Loader2 } from "lucide-react";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import {
  LLM_PROVIDERS,
  PROVIDER_DESCRIPTION,
  PROVIDER_LABEL,
  type LlmProvider,
} from "@/lib/llm-providers";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { WizardStepProps } from "../steps";

// Step 6. The one thing the product cannot run without.
//
// Skippable — a merchant may not have a key to hand, and blocking them here
// would strand them mid-setup. But the cost of skipping is stated plainly, and
// the SetupWarnings banner keeps saying it (in the wizard and afterwards in the
// dashboard) until a key is connected: without one, every ticket parks in
// human takeover.

export function LlmStep({ onDone, canEdit }: WizardStepProps) {
  const ctx = useWorkspaceCtx();
  const qc = useQueryClient();
  const [provider, setProvider] = useState<LlmProvider>("openrouter");

  const status = useQuery({
    queryKey: qk.llmStatus(ctx.workspaceId),
    queryFn: () => api.llmStatus(ctx),
  });

  const connect = useMutation({
    mutationFn: (apiKey: string) =>
      api.connectLlm(ctx, { provider, apiKey }),
    onSuccess: async (res) => {
      if (res.status !== 200) {
        toast.warning(
          "That key was rejected. Check you copied all of it, then try again.",
        );
        return;
      }
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.llmStatus(ctx.workspaceId) }),
        qc.invalidateQueries({ queryKey: qk.connections(ctx.workspaceId) }),
        // The agent's default model is derived from the connected provider, so
        // the next step's picker has to be re-read.
        qc.invalidateQueries({ queryKey: qk.catalog(ctx.workspaceId) }),
        qc.invalidateQueries({ queryKey: qk.models(ctx.workspaceId) }),
      ]);
      toast.success("AI provider connected.");
      onDone();
    },
    onError: () => toast.warning("Couldn't save that key. Please try again."),
  });

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const key = String(new FormData(e.currentTarget).get("apiKey") ?? "").trim();
    if (key.length < 8) {
      toast.warning("That doesn't look like a complete API key.");
      return;
    }
    connect.mutate(key);
  };

  if (status.isLoading) {
    return <Loader2 className="size-5 animate-spin text-muted-foreground" />;
  }

  const effective = status.data?.effective;
  if (effective) {
    return (
      <div className="space-y-6">
        <Card>
          <CardContent className="flex items-center gap-3 py-4">
            <Check className="size-4 shrink-0 text-success" />
            <div>
              <p className="text-sm font-medium">
                {PROVIDER_LABEL[effective.provider as LlmProvider] ??
                  effective.provider}{" "}
                connected
              </p>
              <p className="text-sm text-muted-foreground">
                Your agent can run.
              </p>
            </div>
          </CardContent>
        </Card>
        <Button onClick={onDone}>Continue</Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        {LLM_PROVIDERS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setProvider(p)}
            disabled={!canEdit}
            className={cn(
              "rounded-lg border p-4 text-left transition-colors",
              provider === p
                ? "border-primary bg-primary/5"
                : "hover:border-foreground/20",
            )}
          >
            <span className="flex items-center gap-2 text-sm font-medium">
              <KeyRound className="size-4" />
              {PROVIDER_LABEL[p]}
            </span>
            <span className="mt-1 block text-xs text-muted-foreground">
              {PROVIDER_DESCRIPTION[p]}
            </span>
          </button>
        ))}
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid gap-1.5">
          <Label htmlFor="apiKey">{PROVIDER_LABEL[provider]} API key</Label>
          <Input
            id="apiKey"
            name="apiKey"
            type="password"
            autoComplete="off"
            placeholder="sk-…"
            disabled={!canEdit}
          />
          <p className="text-xs text-muted-foreground">
            Stored encrypted. It never leaves our servers, and it is never sent
            to your browser again.
          </p>
        </div>
        <Button type="submit" disabled={!canEdit || connect.isPending}>
          {connect.isPending && <Loader2 className="size-4 animate-spin" />}
          Connect and continue
        </Button>
      </form>
    </div>
  );
}
