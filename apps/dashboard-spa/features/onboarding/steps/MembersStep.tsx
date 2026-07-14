import type { FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, UserPlus } from "lucide-react";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import type { WizardStepProps } from "../steps";

// Step 10. Optional, and genuinely so: a solo merchant should sail past this.
//
// One invite, one role. The full members surface (custom roles over the
// permission catalog, revoking, re-roling) lives in Settings, and a merchant who
// needs it will find it there.

export function MembersStep({ onDone, canEdit }: WizardStepProps) {
  const ctx = useWorkspaceCtx();

  const roles = useQuery({
    queryKey: qk.roles(ctx.workspaceId),
    queryFn: () => api.roles(ctx),
    enabled: canEdit,
  });

  const invite = useMutation({
    mutationFn: (input: { email: string; roleId: string }) =>
      api.inviteMember(ctx, input),
    onSuccess: (res) => {
      if (res.status !== 200) {
        toast.warning("Couldn't send that invite. Please try again.");
        return;
      }
      toast.success("Invite sent.");
      onDone();
    },
    onError: () => toast.warning("Couldn't send that invite."),
  });

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const roleId = String(form.get("roleId") ?? "").trim();
    if (!email || !roleId) return;
    invite.mutate({ email, roleId });
  };

  const roleList = roles.data?.roles ?? [];

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="email">Their email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            placeholder="teammate@yourstore.com"
            disabled={!canEdit}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="roleId">What they can do</Label>
          <NativeSelect
            id="roleId"
            name="roleId"
            disabled={!canEdit || roles.isLoading}
          >
            {roleList.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        Working alone? Skip this. You can invite people any time from Settings.
      </p>

      <Button type="submit" disabled={!canEdit || invite.isPending}>
        {invite.isPending ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <UserPlus className="size-4" />
        )}
        Send invite
      </Button>
    </form>
  );
}
