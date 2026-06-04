import { Context, Data, Effect, Layer } from "effect";

// ============================================================
// OrgDirectoryService
// ============================================================
//
// Abstracts the external identity directory where a tenant's
// *organization* lives — today WorkOS, where the dashboard authenticates
// managers. The only operation the platform needs is deleting an org
// outright (account deletion): WorkOS `deleteOrganization` removes the
// org and all its manager memberships, but leaves the underlying user
// records (a human who manages two merchants keeps the other org).
//
// Kept abstract here (Tag) so the live WorkOS impl stays in
// `packages/providers`; a second IdP (e.g. self-hosted) gets its own Live
// layer providing into this same Tag. See `platform-mail` for the same
// service/provider split.

export class OrgDirectoryDeleteFailed extends Data.TaggedError(
  "OrgDirectoryDeleteFailed",
)<{
  readonly organizationId: string;
  readonly cause: unknown;
}> {}

export type OrgDirectoryError = OrgDirectoryDeleteFailed;

export class OrgDirectoryService extends Context.Tag("OrgDirectoryService")<
  OrgDirectoryService,
  {
    /**
     * Delete the organization in the IdP. MUST be idempotent: deleting an
     * already-gone org (e.g. a pg-boss retry after the first attempt
     * succeeded) resolves successfully, not as an error — otherwise the
     * cleanup job would never drain.
     */
    readonly deleteOrganization: (
      organizationId: string,
    ) => Effect.Effect<void, OrgDirectoryError>;
  }
>() {}

// ============================================================
// Test layer
// ============================================================

export interface OrgDirectoryTestHandle {
  readonly deleted: ReadonlyArray<string>;
}

export interface OrgDirectoryTestFixtures {
  /**
   * Org ids that should fail with OrgDirectoryDeleteFailed (simulates a
   * transient IdP outage so tests can assert the cleanup job retries).
   */
  readonly failFor?: ReadonlySet<string>;
}

export const makeOrgDirectoryServiceTest = (
  fixtures: OrgDirectoryTestFixtures = {},
): {
  readonly layer: Layer.Layer<OrgDirectoryService>;
  readonly handle: OrgDirectoryTestHandle;
} => {
  const deleted: Array<string> = [];
  const layer = Layer.succeed(
    OrgDirectoryService,
    OrgDirectoryService.of({
      deleteOrganization: (organizationId) =>
        Effect.suspend(
          (): Effect.Effect<void, OrgDirectoryError> => {
            if (fixtures.failFor?.has(organizationId)) {
              return Effect.fail(
                new OrgDirectoryDeleteFailed({
                  organizationId,
                  cause: "fixture: failFor",
                }),
              );
            }
            deleted.push(organizationId);
            return Effect.succeed(undefined);
          },
        ),
    }),
  );
  const handle: OrgDirectoryTestHandle = {
    get deleted() {
      return deleted;
    },
  };
  return { layer, handle };
};

/** Layer-only convenience: when the test doesn't need to inspect deletes. */
export const OrgDirectoryServiceTest = (
  fixtures: OrgDirectoryTestFixtures = {},
): Layer.Layer<OrgDirectoryService> =>
  makeOrgDirectoryServiceTest(fixtures).layer;
