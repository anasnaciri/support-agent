import { Effect, FiberRef, Layer } from "effect";
import { eq } from "drizzle-orm";
import {
  TenantNotFound,
  TenantRepository,
  TenantRepositoryDbError,
  TenantSettings,
} from "@support-agent/services";
import { CurrentTxRef, DbClient } from "./db-client.js";
import { tenants } from "./schema.js";

export const TenantRepositoryLive = Layer.effect(
  TenantRepository,
  Effect.gen(function* () {
    const defaultDb = yield* DbClient;

    const pickDb = FiberRef.get(CurrentTxRef).pipe(
      Effect.map((tx) => tx ?? defaultDb),
    );

    return TenantRepository.of({
      getSettings: (tenantId) =>
        Effect.gen(function* () {
          const db = yield* pickDb;
          const rows = yield* Effect.tryPromise({
            try: () =>
              db
                .select({ settings: tenants.settings })
                .from(tenants)
                .where(eq(tenants.id, tenantId))
                .limit(1),
            catch: (cause) =>
              new TenantRepositoryDbError({
                operation: "getSettings",
                cause,
              }),
          });
          const row = rows[0];
          if (!row) {
            return yield* Effect.fail(new TenantNotFound({ tenantId }));
          }
          const settings = row.settings as
            | { readonly notificationEmail?: unknown }
            | null;
          const notificationEmail =
            settings && typeof settings.notificationEmail === "string"
              ? settings.notificationEmail
              : null;
          return new TenantSettings({ notificationEmail });
        }),
    });
  }),
);
