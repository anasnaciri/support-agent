import { Effect, FiberRef, Layer } from "effect";
import { eq, sql } from "drizzle-orm";
import {
  defaultRefundPolicy,
  DEFAULT_RETENTION_DAYS,
  TenantNotFound,
  TenantRepository,
  TenantRepositoryDbError,
  TenantSettings,
  type RefundPolicy,
  type SupplierEscalationSheet,
} from "@support-agent/services";
import { CurrentTxRef, DbClient } from "./db-client.js";
import { tenants } from "./schema.js";

/**
 * Decode the persisted JSONB `refundPolicy` block. Returns the fallback
 * when the field is missing, malformed, or carries non-integer numbers
 * (defends against hand-edited rows). All three sub-fields are required
 * — partial blocks fall through to the default rather than blending.
 */
const decodeRefundPolicy = (raw: unknown): RefundPolicy => {
  if (!raw || typeof raw !== "object") return defaultRefundPolicy;
  const r = raw as Record<string, unknown>;
  const ask = r["askAboveMinorUnits"];
  const deny = r["denyAboveMinorUnits"];
  const ccy = r["currencyCode"];
  if (
    typeof ask !== "number" ||
    typeof deny !== "number" ||
    typeof ccy !== "string" ||
    !Number.isFinite(ask) ||
    !Number.isFinite(deny) ||
    !Number.isInteger(ask) ||
    !Number.isInteger(deny) ||
    ask < 0 ||
    deny < 0 ||
    ccy.length !== 3
  ) {
    return defaultRefundPolicy;
  }
  return {
    askAboveMinorUnits: ask,
    denyAboveMinorUnits: deny,
    currencyCode: ccy.toUpperCase(),
  };
};

/**
 * Decode the persisted JSONB `supplierEscalationSheet` block. Returns
 * `null` when the field is missing, malformed, or empty — agents check
 * for null and skip the sheet write in that case.
 */
const decodeSupplierEscalationSheet = (
  raw: unknown,
): SupplierEscalationSheet | null => {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const spreadsheetId = r["spreadsheetId"];
  const range = r["range"];
  const description = r["description"];
  if (typeof spreadsheetId !== "string" || spreadsheetId.length === 0) {
    return null;
  }
  if (typeof range !== "string" || range.length === 0) {
    return null;
  }
  return {
    spreadsheetId,
    range,
    description: typeof description === "string" ? description : null,
  };
};

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
            | {
                readonly notificationEmail?: unknown;
                readonly refundPolicy?: unknown;
                readonly retentionDays?: unknown;
                readonly supplierEscalationSheet?: unknown;
              }
            | null;
          const notificationEmail =
            settings && typeof settings.notificationEmail === "string"
              ? settings.notificationEmail
              : null;
          const refundPolicy = decodeRefundPolicy(settings?.refundPolicy);
          // Defensive decode: must be a positive integer. Reject zero
          // (would delete every resolved case instantly) and negative
          // values (nonsensical).
          const rawDays = settings?.retentionDays;
          const retentionDays =
            typeof rawDays === "number" &&
            Number.isInteger(rawDays) &&
            rawDays > 0
              ? rawDays
              : DEFAULT_RETENTION_DAYS;
          const supplierEscalationSheet = decodeSupplierEscalationSheet(
            settings?.supplierEscalationSheet,
          );
          return new TenantSettings({
            notificationEmail,
            refundPolicy,
            retentionDays,
            supplierEscalationSheet,
          });
        }),

      setRefundPolicy: (tenantId, policy) =>
        Effect.gen(function* () {
          const db = yield* pickDb;
          // JSONB merge: keeps `notificationEmail` (and any future
          // sibling settings) untouched while replacing the
          // `refundPolicy` block. Postgres' `||` is a shallow merge —
          // that's exactly the semantic we want here.
          const policyJson = JSON.stringify({ refundPolicy: policy });
          const result = yield* Effect.tryPromise({
            try: () =>
              db
                .update(tenants)
                .set({
                  settings: sql`${tenants.settings} || ${policyJson}::jsonb`,
                })
                .where(eq(tenants.id, tenantId))
                .returning({ id: tenants.id }),
            catch: (cause) =>
              new TenantRepositoryDbError({
                operation: "setRefundPolicy",
                cause,
              }),
          });
          if (result.length === 0) {
            return yield* Effect.fail(new TenantNotFound({ tenantId }));
          }
        }),

      setSupplierEscalationSheet: (tenantId, sheet) =>
        Effect.gen(function* () {
          const db = yield* pickDb;
          // Same shallow-merge as setRefundPolicy. Passing `null`
          // writes the JSONB null literal — the decoder treats null as
          // "no sheet configured" so this acts as a clear.
          const sheetJson = JSON.stringify({
            supplierEscalationSheet: sheet,
          });
          const result = yield* Effect.tryPromise({
            try: () =>
              db
                .update(tenants)
                .set({
                  settings: sql`${tenants.settings} || ${sheetJson}::jsonb`,
                })
                .where(eq(tenants.id, tenantId))
                .returning({ id: tenants.id }),
            catch: (cause) =>
              new TenantRepositoryDbError({
                operation: "setSupplierEscalationSheet",
                cause,
              }),
          });
          if (result.length === 0) {
            return yield* Effect.fail(new TenantNotFound({ tenantId }));
          }
        }),
    });
  }),
);
