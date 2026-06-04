// ============================================================
// Account cleanup — external side-effects after a tenant wipe
// ============================================================
//
// apps/api wipes every tenant row synchronously, then enqueues this job.
// The worker performs the two external side-effects that the api edge
// can't (it has neither WorkOS nor Resend wired): deleting the tenant's
// WorkOS organization and emailing a deletion confirmation. Running here
// means both get pg-boss retry semantics.
//
// The job payload carries everything BECAUSE the tenant row is already
// gone — nothing can be re-read. Mirrors apps/api's AccountCleanupJobData.

import { Effect } from "effect";
import { TenantId } from "@support-agent/agent-core";
import {
  OrgDirectoryService,
  PlatformMailService,
  type OrgDirectoryError,
  type PlatformMailError,
} from "@support-agent/services";

export interface AccountCleanupJobData {
  readonly tenantId: string;
  readonly tenantName: string;
  /** null → headless / Shopify-only tenant; skip the WorkOS step. */
  readonly workosOrganizationId: string | null;
  /** null → no email configured; skip the mail step. */
  readonly notificationEmail: string | null;
}

/**
 * Delete the WorkOS org (if any) then send the deletion email (if a
 * recipient was captured). Org delete is first and idempotent (the Live
 * impl treats a 404 as success), so a pg-boss retry after a failed email
 * re-runs cleanly. Any failure propagates so pg-boss retries the job.
 */
export const runAccountCleanup = (
  data: AccountCleanupJobData,
): Effect.Effect<
  void,
  OrgDirectoryError | PlatformMailError,
  OrgDirectoryService | PlatformMailService
> =>
  Effect.gen(function* () {
    if (data.workosOrganizationId) {
      const dir = yield* OrgDirectoryService;
      yield* dir.deleteOrganization(data.workosOrganizationId);
    }
    if (data.notificationEmail) {
      const mail = yield* PlatformMailService;
      yield* mail.sendAccountDeleted({
        tenantId: TenantId(data.tenantId),
        tenantName: data.tenantName,
        recipientEmail: data.notificationEmail,
      });
    }
  });
