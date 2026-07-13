import type { WorkosOrgAdminDirectory } from "./workos-directory.js";

/**
 * Decide which WorkOS invitation id to persist for a member/fulfillment-operator invite.
 *
 * - If the caller already minted one, use it as-is. The Next dashboard sends
 *   WorkOS's invitation id from its own server action (it holds `WORKOS_API_KEY`),
 *   so that path is unchanged.
 * - Otherwise send the invitation SERVER-SIDE via the admin directory and use the
 *   returned id. This is the Vite SPA path — the browser has no `WORKOS_API_KEY`,
 *   so the api owns the WorkOS send.
 * - If there's no admin directory (`WORKOS_API_KEY` unset) or the send fails,
 *   return undefined. The invitation is still persisted and reconciles on the
 *   invitee's VERIFIED email at first load (`/me/session`); only the WorkOS
 *   invitation email is skipped. Soft-fail — never throws.
 */
export const resolveInvitationId = async (input: {
  readonly provided: string | undefined;
  readonly adminDir: WorkosOrgAdminDirectory | null;
  readonly email: string;
  readonly organizationId: string;
  readonly inviterUserId?: string | undefined;
}): Promise<string | undefined> => {
  if (input.provided) return input.provided;
  if (!input.adminDir) return undefined;
  const sent = await input.adminDir.sendInvitation({
    email: input.email,
    organizationId: input.organizationId,
    ...(input.inviterUserId ? { inviterUserId: input.inviterUserId } : {}),
  });
  return sent?.id ?? undefined;
};
