import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronRight } from "lucide-react";

import type {
  MemberInvitationView,
  MemberView,
  RbacPermissionDef,
  RoleView,
} from "@support-agent/dashboard-contracts";
import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { useRequirePermission } from "@/lib/require-permission";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

// SPA port of apps/dashboard/app/settings/members. The Next page used server
// actions + post-redirect-get banners (?ok / ?error); here every sub-action is a
// TanStack mutation that toasts the SAME copy and invalidates the members/roles
// reads (the equivalent of the actions' `revalidatePath("/settings/members")`).

const OK_COPY = {
  invited: "Invitation sent.",
  revoked: "Invitation revoked.",
  role_changed: "Member role updated.",
  removed: "Member removed.",
  role_created: "Role created.",
  role_renamed: "Role renamed.",
  role_deleted: "Role deleted.",
  permissions_saved: "Role permissions saved.",
} as const;

const ERROR_COPY: Record<string, string> = {
  invalid_invite: "Enter a valid email and pick a role.",
  invalid_role: "Enter a role name.",
  duplicate_pending: "That email already has a pending invitation.",
  duplicate_name: "A role with that name already exists.",
  role_in_use: "Reassign members off this role before deleting it.",
  owner_immutable: "The Owner role can't be edited or deleted.",
  role_not_found: "That role no longer exists.",
};

interface PermissionGroup {
  readonly category: string;
  readonly items: ReadonlyArray<RbacPermissionDef>;
}

const groupByCategory = (
  catalog: ReadonlyArray<RbacPermissionDef>,
): ReadonlyArray<PermissionGroup> => {
  const order: string[] = [];
  const byCat = new Map<string, RbacPermissionDef[]>();
  for (const p of catalog) {
    if (!byCat.has(p.category)) {
      byCat.set(p.category, []);
      order.push(p.category);
    }
    byCat.get(p.category)!.push(p);
  }
  return order.map((category) => ({ category, items: byCat.get(category)! }));
};

interface WriteResult {
  readonly status: number;
  readonly body: unknown;
}

// Shared wiring for every members/roles write: run the api call, toast the same
// banner copy the Next actions redirected with, and invalidate the members +
// roles reads (revalidatePath equivalent). `mapErrors` mirrors the actions that
// checked `status !== 200` and surfaced a specific ERROR_COPY message (invite /
// create role / delete role); the rest always report success like their action.
function useMemberWrite<TVars = void>(opts: {
  readonly mutationFn: (vars: TVars) => Promise<WriteResult>;
  readonly okText: string;
  readonly mapErrors?: boolean;
  readonly onOk?: (body: unknown) => void;
}) {
  const ctx = useWorkspaceCtx();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: opts.mutationFn,
    onSuccess: ({ status, body }) => {
      if (opts.mapErrors && status !== 200) {
        const code = (body as { error?: string } | null)?.error;
        toast.warning(
          (code && ERROR_COPY[code]) ??
            "Something went wrong. Please try again.",
        );
        return;
      }
      opts.onOk?.(body);
      toast.success(opts.okText);
      void qc.invalidateQueries({ queryKey: qk.members(ctx.workspaceId) });
      void qc.invalidateQueries({ queryKey: qk.roles(ctx.workspaceId) });
    },
    onError: () => {
      toast.warning("Something went wrong. Please try again.");
    },
  });
}

// ---- Team member row: change role + remove ----
function MemberRow({
  member,
  roles,
}: {
  readonly member: MemberView;
  readonly roles: ReadonlyArray<RoleView>;
}) {
  const ctx = useWorkspaceCtx();
  const [roleId, setRoleId] = useState(member.roleId);
  const changeM = useMemberWrite({
    mutationFn: () => api.setMemberRole(ctx, member.userDecisionUuid, roleId),
    okText: OK_COPY.role_changed,
  });
  const removeM = useMemberWrite({
    mutationFn: () => api.removeMember(ctx, member.userDecisionUuid),
    okText: OK_COPY.removed,
  });

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border/60 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{member.email}</p>
        {member.isOwner ? (
          <Badge variant="secondary" className="mt-1">
            Owner
          </Badge>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (roleId) changeM.mutate();
          }}
          className="flex items-center gap-2"
        >
          <NativeSelect
            value={roleId}
            onChange={(e) => setRoleId(e.currentTarget.value)}
            aria-label={`Role for ${member.email}`}
          >
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </NativeSelect>
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={changeM.isPending}
          >
            Save
          </Button>
        </form>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={removeM.isPending}
          onClick={() => removeM.mutate()}
        >
          Remove
        </Button>
      </div>
    </div>
  );
}

// ---- Pending invitation row: revoke ----
function InvitationRow({
  invitation,
}: {
  readonly invitation: MemberInvitationView;
}) {
  const ctx = useWorkspaceCtx();
  const revokeM = useMemberWrite({
    mutationFn: () => api.revokeInvitation(ctx, invitation.id),
    okText: OK_COPY.revoked,
  });

  return (
    <div className="flex items-center justify-between rounded-lg border border-border/60 p-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{invitation.email}</p>
        <p className="text-xs text-muted-foreground">{invitation.roleName}</p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={revokeM.isPending}
        onClick={() => revokeM.mutate()}
      >
        Revoke
      </Button>
    </div>
  );
}

// ---- One collapsible role row: rename / delete + permission editor ----
function RoleRow({
  role,
  grouped,
  catalogLength,
  open,
  onOpenChange,
}: {
  readonly role: RoleView;
  readonly grouped: ReadonlyArray<PermissionGroup>;
  readonly catalogLength: number;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const ctx = useWorkspaceCtx();
  const [name, setName] = useState(role.name);
  const [selected, setSelected] = useState(() => new Set(role.permissionIds));

  const renameM = useMemberWrite({
    mutationFn: () => api.renameRole(ctx, role.id, name.trim()),
    okText: OK_COPY.role_renamed,
    mapErrors: true,
  });
  const deleteM = useMemberWrite({
    mutationFn: () => api.deleteRole(ctx, role.id),
    okText: OK_COPY.role_deleted,
    mapErrors: true,
  });
  const saveM = useMemberWrite({
    mutationFn: () => api.setRolePermissions(ctx, role.id, [...selected]),
    okText: OK_COPY.permissions_saved,
    mapErrors: true,
  });

  const grantCount = role.isOwner ? catalogLength : role.permissionIds.length;

  return (
    <details
      open={open}
      onToggle={(e) => onOpenChange(e.currentTarget.open)}
      className="group rounded-lg border border-border/60 [&>summary]:list-none"
    >
      <summary className="flex cursor-pointer select-none items-center justify-between gap-3 rounded-lg px-4 py-3 hover:bg-accent/40 [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 items-center gap-2">
          <ChevronRight
            className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
            aria-hidden
          />
          <span className="truncate font-medium">{role.name}</span>
          {role.isOwner ? <Badge variant="secondary">All access</Badge> : null}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {role.isOwner
            ? "Every permission"
            : `${grantCount} permission${grantCount === 1 ? "" : "s"}`}
          {" · "}
          {role.assignedMemberCount} member
          {role.assignedMemberCount === 1 ? "" : "s"}
        </span>
      </summary>

      <div className="space-y-4 border-t border-border/60 p-4">
        {!role.isOwner ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim()) renameM.mutate();
              }}
              className="flex items-center gap-1"
            >
              <Input
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                className="h-8 w-40"
                aria-label={`Rename ${role.name}`}
              />
              <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={renameM.isPending}
              >
                Rename
              </Button>
            </form>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={deleteM.isPending}
              onClick={() => deleteM.mutate()}
            >
              Delete
            </Button>
          </div>
        ) : null}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            saveM.mutate();
          }}
          className="space-y-4"
        >
          {grouped.map((group) => (
            <fieldset key={group.category} className="space-y-1.5">
              <legend className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {group.category}
              </legend>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {group.items.map((perm) => {
                  const checked = role.isOwner || selected.has(perm.id);
                  return (
                    <label
                      key={perm.id}
                      className="flex items-start gap-2 text-sm"
                      title={perm.description}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={role.isOwner}
                        onChange={(e) => {
                          const on = e.currentTarget.checked;
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (on) next.add(perm.id);
                            else next.delete(perm.id);
                            return next;
                          });
                        }}
                        className="mt-0.5"
                      />
                      <span>{perm.label}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ))}
          {role.isOwner ? (
            <p className="text-xs text-muted-foreground">
              The Owner role always has every permission.
            </p>
          ) : (
            <Button
              type="submit"
              variant="outline"
              size="sm"
              disabled={saveM.isPending}
            >
              Save permissions
            </Button>
          )}
        </form>
      </div>
    </details>
  );
}

export function MembersPage() {
  const allowed = useRequirePermission("members.manage");
  const ctx = useWorkspaceCtx();

  const membersQuery = useQuery({
    queryKey: qk.members(ctx.workspaceId),
    queryFn: () => api.members(ctx),
    enabled: allowed,
  });
  const rolesQuery = useQuery({
    queryKey: qk.roles(ctx.workspaceId),
    queryFn: () => api.roles(ctx),
    enabled: allowed,
  });
  const catalogQuery = useQuery({
    queryKey: qk.permissionCatalog(ctx.workspaceId),
    queryFn: () => api.permissionCatalog(ctx),
    enabled: allowed,
  });

  // Keep the just-edited/created role expanded; everything else collapsed so the
  // section stays compact (the SPA replacement for the Next `?role=` PRG param).
  const [openRoleId, setOpenRoleId] = useState<string | undefined>(undefined);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRoleId, setInviteRoleId] = useState("");
  const [newRoleName, setNewRoleName] = useState("");

  const roles = rolesQuery.data?.roles ?? [];
  const catalog = catalogQuery.data ?? [];
  const members = membersQuery.data?.members ?? [];
  const invitations = membersQuery.data?.invitations ?? [];
  const grouped = groupByCategory(catalog);
  const assignableRoles = roles;
  const effectiveInviteRoleId = inviteRoleId || roles[0]?.id || "";

  const inviteM = useMemberWrite({
    mutationFn: () =>
      api.inviteMember(ctx, {
        email: inviteEmail.trim(),
        roleId: effectiveInviteRoleId,
      }),
    okText: OK_COPY.invited,
    mapErrors: true,
    onOk: () => setInviteEmail(""),
  });
  const createM = useMemberWrite({
    mutationFn: () => api.createRole(ctx, newRoleName.trim()),
    okText: OK_COPY.role_created,
    mapErrors: true,
    onOk: (body) => {
      const newId = (body as { roleId?: string } | null)?.roleId;
      if (newId) setOpenRoleId(newId);
      setNewRoleName("");
    },
  });

  if (!allowed) return null;

  if (membersQuery.isLoading || rolesQuery.isLoading || catalogQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  const onInvite = (e: React.FormEvent) => {
    e.preventDefault();
    const email = inviteEmail.trim();
    if (!email || !email.includes("@") || !effectiveInviteRoleId) {
      toast.warning(ERROR_COPY.invalid_invite);
      return;
    }
    inviteM.mutate();
  };

  const onCreateRole = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRoleName.trim()) {
      toast.warning(ERROR_COPY.invalid_role);
      return;
    }
    createM.mutate();
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Members</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Invite teammates and choose exactly what each one can do. Roles are
          sets of permissions you control.
        </p>
      </div>

      {/* Invite */}
      <Card>
        <CardHeader>
          <CardTitle>Invite a member</CardTitle>
          <CardDescription>
            They’ll get an email to join. Until they accept, they appear under
            pending invitations.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={onInvite}
            className="flex flex-col gap-3 sm:flex-row sm:items-end"
          >
            <div className="flex-1 space-y-1.5">
              <label htmlFor="invite-email" className="text-sm font-medium">
                Email
              </label>
              <Input
                id="invite-email"
                name="email"
                type="email"
                required
                placeholder="teammate@yourstore.com"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.currentTarget.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="invite-role" className="text-sm font-medium">
                Role
              </label>
              <NativeSelect
                id="invite-role"
                name="roleId"
                required
                value={effectiveInviteRoleId}
                onChange={(e) => setInviteRoleId(e.currentTarget.value)}
              >
                {assignableRoles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <Button type="submit" disabled={inviteM.isPending}>
              Send invite
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Members */}
      <Card>
        <CardHeader>
          <CardTitle>Team</CardTitle>
          <CardDescription>
            {members.length === 0
              ? "No members yet. Invite someone above."
              : "Change a member’s role or remove their access."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {members.map((m) => (
            <MemberRow
              key={m.userDecisionUuid}
              member={m}
              roles={assignableRoles}
            />
          ))}
        </CardContent>
      </Card>

      {/* Pending invitations */}
      {invitations.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Pending invitations</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {invitations.map((inv) => (
              <InvitationRow key={inv.id} invitation={inv} />
            ))}
          </CardContent>
        </Card>
      ) : null}

      {/* Roles */}
      <Card>
        <CardHeader>
          <CardTitle>Roles</CardTitle>
          <CardDescription>
            A role is a named set of permissions. Tick what each role can do.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {roles.map((role) => (
            <RoleRow
              key={role.id}
              role={role}
              grouped={grouped}
              catalogLength={catalog.length}
              open={openRoleId === role.id}
              onOpenChange={(isOpen) =>
                setOpenRoleId((prev) =>
                  isOpen ? role.id : prev === role.id ? undefined : prev,
                )
              }
            />
          ))}

          {/* Create role */}
          <form
            onSubmit={onCreateRole}
            className="flex items-end gap-2 border-t border-border/60 pt-4"
          >
            <div className="space-y-1.5">
              <label htmlFor="new-role" className="text-sm font-medium">
                New role
              </label>
              <Input
                id="new-role"
                name="name"
                placeholder="e.g. Support"
                className="w-56"
                value={newRoleName}
                onChange={(e) => setNewRoleName(e.currentTarget.value)}
              />
            </div>
            <Button type="submit" disabled={createM.isPending}>
              Create role
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
