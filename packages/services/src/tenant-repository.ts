import { Context, Data, Effect, Layer } from "effect";
import type { TenantId } from "@support-agent/agent-core";

// ============================================================
// TenantRepository
// ============================================================
//
// Read access to the `tenants` table. Today the only field anyone
// needs through the Tag is the operator's notification email (where
// approval-link mail goes); the interface stays narrow so adding new
// columns doesn't ripple. When the dashboard lands and tenants gain a
// full settings UI, we widen this in one place — `db/...-live` follows.
//
// Why a separate Tag (not just DbClient + drizzle inline): the
// PlatformMailServiceLive lives in `providers`, and CLAUDE.md keeps
// `providers` free of Postgres/db dependencies. Tags in services let
// `providers` consume tenant data without crossing the layer rule.

export class TenantSettings extends Data.Class<{
  /** Email the platform sends approval / system mail to. */
  readonly notificationEmail: string | null;
}> {}

export class TenantNotFound extends Data.TaggedError("TenantNotFound")<{
  readonly tenantId: TenantId;
}> {}

export class TenantRepositoryDbError extends Data.TaggedError(
  "TenantRepositoryDbError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export type TenantRepositoryError = TenantNotFound | TenantRepositoryDbError;

export class TenantRepository extends Context.Tag("TenantRepository")<
  TenantRepository,
  {
    readonly getSettings: (
      tenantId: TenantId,
    ) => Effect.Effect<TenantSettings, TenantRepositoryError>;
  }
>() {}

// ============================================================
// Test layer
// ============================================================

export interface TenantRepositoryTestFixtures {
  readonly settingsByTenant?: ReadonlyMap<TenantId, TenantSettings>;
}

export const TenantRepositoryTest = (
  fixtures: TenantRepositoryTestFixtures = {},
): Layer.Layer<TenantRepository> =>
  Layer.succeed(
    TenantRepository,
    TenantRepository.of({
      getSettings: (tenantId) => {
        const hit = fixtures.settingsByTenant?.get(tenantId);
        return hit
          ? Effect.succeed(hit)
          : Effect.fail(new TenantNotFound({ tenantId }));
      },
    }),
  );
