import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Loader2, Store } from "lucide-react";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import type { WizardStepProps } from "../steps";
import { activeConnection, useConnections, useWizardConnect } from "../use-connect";

// Step 1. Connecting the store is what makes everything downstream possible:
// it's where orders, policies, and store pages come from. Once connected we ask
// the merchant to confirm the brand name we read from Shopify, because that is
// the name the agent will use when it talks to their customers, and only they
// can say whether the store's legal name is the one to use.

export function StoreStep({ onDone, canEdit }: WizardStepProps) {
  const ctx = useWorkspaceCtx();
  const qc = useQueryClient();
  const connections = useConnections();
  const connect = useWizardConnect("store");

  const shopify = activeConnection(connections.data, "shopify");
  const connected = Boolean(shopify);

  const profile = useQuery({
    queryKey: qk.storeProfile(ctx.workspaceId),
    queryFn: () => api.storeProfile(ctx),
    enabled: connected,
  });
  const settings = useQuery({
    queryKey: qk.settings(ctx.workspaceId),
    queryFn: () => api.settings(ctx),
    enabled: connected,
  });

  const [brand, setBrand] = useState("");
  const [touched, setTouched] = useState(false);

  // Prefill from what the merchant already saved, else from the store's own
  // name. Never overwrite something they're in the middle of typing.
  useEffect(() => {
    if (touched) return;
    const saved = settings.data?.brandName;
    const fromStore = profile.data?.name;
    const next = saved ?? fromStore ?? "";
    if (next) setBrand(next);
  }, [touched, settings.data?.brandName, profile.data?.name]);

  const save = useMutation({
    mutationFn: (name: string) => api.setBrandName(ctx, name),
    onSuccess: async (result) => {
      if (result.status !== 200) {
        toast.warning("Couldn't save the store name. Please try again.");
        return;
      }
      await qc.invalidateQueries({ queryKey: qk.settings(ctx.workspaceId) });
      onDone();
    },
    onError: () =>
      toast.warning("Couldn't save the store name. Please try again."),
  });

  if (connections.isLoading) {
    return <Loader2 className="size-5 animate-spin text-muted-foreground" />;
  }

  if (!connected) {
    return (
      <Card>
        <CardContent className="flex flex-col items-start gap-4 py-6">
          <div className="flex items-center gap-3">
            <Store className="size-5 text-muted-foreground" />
            <div>
              <p className="font-medium">Shopify</p>
              <p className="text-sm text-muted-foreground">
                We'll import your shipping and refund policies and your store
                pages, so the agent can answer from them.
              </p>
            </div>
          </div>
          <Button
            onClick={() => connect.mutate("shopify")}
            disabled={!canEdit || connect.isPending}
          >
            {connect.isPending && <Loader2 className="size-4 animate-spin" />}
            Connect Shopify
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="flex items-center gap-3 py-4">
          <Check className="size-4 shrink-0 text-success" />
          <div className="min-w-0">
            <p className="text-sm font-medium">Shopify connected</p>
            <p className="truncate text-sm text-muted-foreground">
              {shopify?.shopDomain ?? "Your store"}
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-2">
        <Label htmlFor="brand">What should we call your store?</Label>
        <Input
          id="brand"
          value={brand}
          onChange={(e) => {
            setTouched(true);
            setBrand(e.target.value);
          }}
          placeholder={profile.data?.name ?? "Your store name"}
          maxLength={120}
          disabled={!canEdit}
        />
        <p className="text-sm text-muted-foreground">
          This is the name the agent uses when it writes to your customers. We
          read it from your store — change it if you go by something else.
        </p>
      </div>

      <Button
        onClick={() => save.mutate(brand.trim())}
        disabled={!canEdit || brand.trim().length === 0 || save.isPending}
      >
        {save.isPending && <Loader2 className="size-4 animate-spin" />}
        Save and continue
      </Button>
    </div>
  );
}
