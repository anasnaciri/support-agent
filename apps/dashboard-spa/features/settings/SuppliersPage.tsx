import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { useRequirePermission } from "@/lib/require-permission";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Invite a supplier — SPA port of apps/dashboard's /settings/suppliers page +
// inviteSupplierAction. The Next action sent the WorkOS org invitation itself
// (server action), then persisted the supplier + pending binding via
// api.inviteSupplier; here the browser can't reach WorkOS, so we call
// api.inviteSupplier without a workosInvitationId and the api sends the
// invitation server-side. The action's post-redirect-get feedback (?ok=invited
// / ?error=code) is replaced by toasts fired from the mutation callbacks with
// the identical copy. Gated on members.manage, mirroring the members-invite UX.

export function SuppliersPage() {
  const ctx = useWorkspaceCtx();
  const qc = useQueryClient();
  const allowed = useRequirePermission("members.manage");

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  const invite = useMutation({
    mutationFn: (input: { readonly email: string; readonly name?: string }) =>
      api.inviteSupplier(ctx, input),
    onSuccess: ({ status, body }) => {
      if (status !== 200) {
        const reason =
          (body as { error?: string } | null)?.error ?? "invite_failed";
        toast.warning(`Couldn't send the invitation (${reason}).`);
        return;
      }
      toast.success(
        "Invitation sent. They'll see escalated tickets after they sign in.",
      );
      // A supplier binding + pending invitation was created; keep the members
      // view fresh (revalidatePath("/settings/suppliers") had no on-page read).
      void qc.invalidateQueries({ queryKey: qk.members(ctx.workspaceId) });
      setName("");
      setEmail("");
    },
    onError: () =>
      toast.warning("Couldn't send the invitation (invite_failed)."),
  });

  if (!allowed) return null;

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const trimmedEmail = email.trim();
    const trimmedName = name.trim();
    if (!trimmedEmail || !trimmedEmail.includes("@")) {
      toast.warning("Couldn't send the invitation (invalid_invite).");
      return;
    }
    invite.mutate({
      email: trimmedEmail,
      ...(trimmedName ? { name: trimmedName } : {}),
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Suppliers</h1>
        <p className="pt-1 text-sm text-muted-foreground">
          Invite a warehouse or supplier contact. They get a sign-in link and a
          portal showing only the tickets your agent escalates to them: the
          problem, order reference, ship-to, and tracking, never your customers&apos;
          details.
        </p>
      </div>

      <form
        onSubmit={onSubmit}
        className="space-y-4 rounded-lg border border-border bg-background p-5"
      >
        <div className="space-y-1.5">
          <Label htmlFor="name">Supplier name</Label>
          <Input
            id="name"
            name="name"
            placeholder="Acme Warehouse"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            required
            placeholder="ops@acme-warehouse.com"
            value={email}
            onChange={(e) => setEmail(e.currentTarget.value)}
          />
        </div>
        <Button type="submit" disabled={invite.isPending}>
          {invite.isPending ? "Sending…" : "Send invitation"}
        </Button>
      </form>
    </div>
  );
}
