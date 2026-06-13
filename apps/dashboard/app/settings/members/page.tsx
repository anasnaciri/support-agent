import { ChevronRight } from "lucide-react";

import type { RbacPermissionDef } from "@support-agent/dashboard-contracts";
import { api } from "@/lib/api-client";
import { requirePermission } from "@/lib/require-permission";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import {
  changeRoleAction,
  createRoleAction,
  deleteRoleAction,
  inviteMemberAction,
  removeMemberAction,
  renameRoleAction,
  revokeInvitationAction,
  saveRolePermissionsAction,
} from "./actions";

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const OK_COPY: Record<string, string> = {
  invited: "Invitation sent.",
  revoked: "Invitation revoked.",
  role_changed: "Member role updated.",
  removed: "Member removed.",
  role_created: "Role created.",
  role_renamed: "Role renamed.",
  role_deleted: "Role deleted.",
  permissions_saved: "Role permissions saved.",
};

const ERROR_COPY: Record<string, string> = {
  invalid_invite: "Enter a valid email and pick a role.",
  invalid_role: "Enter a role name.",
  duplicate_pending: "That email already has a pending invitation.",
  duplicate_name: "A role with that name already exists.",
  role_in_use: "Reassign members off this role before deleting it.",
  owner_immutable: "The Owner role can't be edited or deleted.",
  role_not_found: "That role no longer exists.",
};

const groupByCategory = (
  catalog: ReadonlyArray<RbacPermissionDef>,
): ReadonlyArray<{
  readonly category: string;
  readonly items: ReadonlyArray<RbacPermissionDef>;
}> => {
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

export default async function MembersPage({ searchParams }: PageProps) {
  const ctx = await requirePermission("members.manage");
  const [{ members, invitations }, { roles }, catalog] = await Promise.all([
    api.members(ctx),
    api.roles(ctx),
    api.permissionCatalog(ctx),
  ]);
  const params = await searchParams;
  const okCode = typeof params.ok === "string" ? params.ok : undefined;
  const errorCode = typeof params.error === "string" ? params.error : undefined;
  // Keep the just-edited role expanded after a PRG redirect; everything else
  // starts collapsed so the section stays compact.
  const openRoleId = typeof params.role === "string" ? params.role : undefined;
  const grouped = groupByCategory(catalog);
  const assignableRoles = roles;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Members</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Invite teammates and choose exactly what each one can do. Roles are
          sets of permissions you control.
        </p>
      </div>

      {okCode && OK_COPY[okCode] ? (
        <Alert>
          <AlertDescription>{OK_COPY[okCode]}</AlertDescription>
        </Alert>
      ) : null}
      {errorCode ? (
        <Alert variant="destructive">
          <AlertDescription>
            {ERROR_COPY[errorCode] ?? "Something went wrong. Please try again."}
          </AlertDescription>
        </Alert>
      ) : null}

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
            action={inviteMemberAction}
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
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="invite-role" className="text-sm font-medium">
                Role
              </label>
              <NativeSelect id="invite-role" name="roleId" required>
                {assignableRoles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <Button type="submit">Send invite</Button>
          </form>
        </CardContent>
      </Card>

      {/* Members */}
      <Card>
        <CardHeader>
          <CardTitle>Team</CardTitle>
          <CardDescription>
            {members.length === 0
              ? "No members yet — invite someone above."
              : "Change a member’s role or remove their access."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {members.map((m) => (
            <div
              key={m.userDecisionUuid}
              className="flex flex-col gap-3 rounded-lg border border-border/60 p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{m.email}</p>
                {m.isOwner ? (
                  <Badge variant="secondary" className="mt-1">
                    Owner
                  </Badge>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <form action={changeRoleAction} className="flex items-center gap-2">
                  <input
                    type="hidden"
                    name="userDecisionUuid"
                    value={m.userDecisionUuid}
                  />
                  <NativeSelect
                    name="roleId"
                    defaultValue={m.roleId}
                    aria-label={`Role for ${m.email}`}
                  >
                    {assignableRoles.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </NativeSelect>
                  <Button type="submit" variant="outline" size="sm">
                    Save
                  </Button>
                </form>
                <form action={removeMemberAction}>
                  <input
                    type="hidden"
                    name="userDecisionUuid"
                    value={m.userDecisionUuid}
                  />
                  <Button type="submit" variant="ghost" size="sm">
                    Remove
                  </Button>
                </form>
              </div>
            </div>
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
              <div
                key={inv.id}
                className="flex items-center justify-between rounded-lg border border-border/60 p-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{inv.email}</p>
                  <p className="text-xs text-muted-foreground">{inv.roleName}</p>
                </div>
                <form action={revokeInvitationAction}>
                  <input type="hidden" name="invitationId" value={inv.id} />
                  <Button type="submit" variant="ghost" size="sm">
                    Revoke
                  </Button>
                </form>
              </div>
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
          {/* One collapsible row per role — collapsed by default so the section
              stays compact; the summary shows the at-a-glance counts and the
              body holds the permission editor. Native <details> = no client JS. */}
          {roles.map((role) => {
            const grantCount = role.isOwner
              ? catalog.length
              : role.permissionIds.length;
            return (
              <details
                key={role.id}
                open={openRoleId === role.id}
                className="group rounded-lg border border-border/60 [&>summary]:list-none"
              >
                <summary className="flex cursor-pointer select-none items-center justify-between gap-3 rounded-lg px-4 py-3 hover:bg-accent/40 [&::-webkit-details-marker]:hidden">
                  <span className="flex min-w-0 items-center gap-2">
                    <ChevronRight
                      className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
                      aria-hidden
                    />
                    <span className="truncate font-medium">{role.name}</span>
                    {role.isOwner ? (
                      <Badge variant="secondary">All access</Badge>
                    ) : null}
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
                        action={renameRoleAction}
                        className="flex items-center gap-1"
                      >
                        <input type="hidden" name="roleId" value={role.id} />
                        <Input
                          name="name"
                          defaultValue={role.name}
                          className="h-8 w-40"
                          aria-label={`Rename ${role.name}`}
                        />
                        <Button type="submit" variant="outline" size="sm">
                          Rename
                        </Button>
                      </form>
                      <form action={deleteRoleAction}>
                        <input type="hidden" name="roleId" value={role.id} />
                        <Button type="submit" variant="ghost" size="sm">
                          Delete
                        </Button>
                      </form>
                    </div>
                  ) : null}

                  <form action={saveRolePermissionsAction} className="space-y-4">
                    <input type="hidden" name="roleId" value={role.id} />
                    {grouped.map((group) => (
                      <fieldset key={group.category} className="space-y-1.5">
                        <legend className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          {group.category}
                        </legend>
                        <div className="grid gap-1.5 sm:grid-cols-2">
                          {group.items.map((perm) => {
                            const checked =
                              role.isOwner ||
                              role.permissionIds.includes(perm.id);
                            return (
                              <label
                                key={perm.id}
                                className="flex items-start gap-2 text-sm"
                                title={perm.description}
                              >
                                <input
                                  type="checkbox"
                                  name="permissionIds"
                                  value={perm.id}
                                  defaultChecked={checked}
                                  disabled={role.isOwner}
                                  className="mt-0.5"
                                />
                                <span>{perm.label}</span>
                              </label>
                            );
                          })}
                        </div>
                      </fieldset>
                    ))}
                    {!role.isOwner ? (
                      <Button type="submit" variant="outline" size="sm">
                        Save permissions
                      </Button>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        The Owner role always has every permission.
                      </p>
                    )}
                  </form>
                </div>
              </details>
            );
          })}

          {/* Create role */}
          <form
            action={createRoleAction}
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
              />
            </div>
            <Button type="submit">Create role</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
