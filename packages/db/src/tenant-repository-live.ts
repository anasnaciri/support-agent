import { Effect, FiberRef, Layer } from "effect";
import { eq, sql } from "drizzle-orm";
import {
  decodeBlockedSenders,
  decodeShippingFacts,
  decodeReturnsFacts,
  decodeResolutionPolicy,
  defaultRefundPolicy,
  defaultDiscountPolicy,
  DEFAULT_RETENTION_DAYS,
  TenantNotFound,
  TenantRepository,
  TenantRepositoryDbError,
  TenantSettings,
  type BlockedSenders,
  type ShippingFacts,
  type ReturnsFacts,
  type DiscountPolicy,
  type DiscountPolicyMode,
  type LegalAcceptance,
  type RefundPolicy,
  type RefundPolicyMode,
  type ResolutionPolicy,
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
    mode: decodeRefundMode(r["mode"]),
  };
};

/**
 * Resolve the persisted `mode`. Rows written before the mode field carry no
 * `mode` and fall through to `thresholds` (the safe default).
 */
const decodeRefundMode = (raw: unknown): RefundPolicyMode => {
  if (raw === "thresholds" || raw === "always_ask" || raw === "always_deny") {
    return raw;
  }
  return "thresholds";
};

/**
 * Decode the persisted JSONB `discountPolicy` block. Returns the fallback
 * when the field is missing, malformed, or carries out-of-range numbers
 * (defends against hand-edited rows). All numeric sub-fields are required
 * — a partial block falls through to the default rather than blending.
 */
const decodeDiscountPolicy = (raw: unknown): DiscountPolicy => {
  if (!raw || typeof raw !== "object") return defaultDiscountPolicy;
  const r = raw as Record<string, unknown>;
  const askPct = r["askAbovePercentage"];
  const maxPct = r["maxPercentage"];
  const askAmt = r["askAboveFixedAmountMinorUnits"];
  const maxAmt = r["maxFixedAmountMinorUnits"];
  const ccy = r["currencyCode"];
  const days = r["maxValidityDays"];
  if (
    typeof askPct !== "number" ||
    typeof maxPct !== "number" ||
    typeof askAmt !== "number" ||
    typeof maxAmt !== "number" ||
    typeof days !== "number" ||
    typeof ccy !== "string" ||
    !Number.isFinite(askPct) ||
    !Number.isFinite(maxPct) ||
    !Number.isInteger(askAmt) ||
    !Number.isInteger(maxAmt) ||
    !Number.isInteger(days) ||
    askPct < 0 ||
    maxPct < 0 ||
    maxPct > 100 ||
    askAmt < 0 ||
    maxAmt < 0 ||
    days < 1 ||
    ccy.length !== 3
  ) {
    return defaultDiscountPolicy;
  }
  return {
    askAbovePercentage: askPct,
    maxPercentage: maxPct,
    askAboveFixedAmountMinorUnits: askAmt,
    maxFixedAmountMinorUnits: maxAmt,
    currencyCode: ccy.toUpperCase(),
    maxValidityDays: days,
    mode: decodeDiscountMode(r["mode"]),
  };
};

/** Resolve the persisted discount `mode`; unknown/absent ⇒ `thresholds`. */
const decodeDiscountMode = (raw: unknown): DiscountPolicyMode => {
  if (raw === "thresholds" || raw === "always_ask" || raw === "always_deny") {
    return raw;
  }
  return "thresholds";
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

const decodeLegalAcceptance = (raw: unknown): LegalAcceptance | null => {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const dataProcessingNoticeVersion = r["dataProcessingNoticeVersion"];
  const dpaVersion = r["dpaVersion"];
  const acceptedAt = r["acceptedAt"];
  const acceptedByUserId = r["acceptedByUserId"];
  if (
    typeof dataProcessingNoticeVersion !== "string" ||
    dataProcessingNoticeVersion.length === 0 ||
    typeof dpaVersion !== "string" ||
    dpaVersion.length === 0 ||
    typeof acceptedAt !== "string" ||
    acceptedAt.length === 0
  ) {
    return null;
  }
  return {
    dataProcessingNoticeVersion,
    dpaVersion,
    acceptedAt,
    acceptedByUserId:
      typeof acceptedByUserId === "string" && acceptedByUserId.length > 0
        ? acceptedByUserId
        : null,
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
                readonly discountPolicy?: unknown;
                readonly retentionDays?: unknown;
                readonly supplierEscalationSheet?: unknown;
                readonly legalAcceptance?: unknown;
                readonly rephraseModel?: unknown;
                readonly cancellationRestock?: unknown;
                readonly resolutionPolicy?: unknown;
                readonly blockedSenders?: unknown;
                readonly shippingFacts?: unknown;
                readonly returnsFacts?: unknown;
              }
            | null;
          const notificationEmail =
            settings && typeof settings.notificationEmail === "string"
              ? settings.notificationEmail
              : null;
          const refundPolicy = decodeRefundPolicy(settings?.refundPolicy);
          const discountPolicy = decodeDiscountPolicy(settings?.discountPolicy);
          // Defensive decode: must be a positive integer. Reject zero
          // (would delete every resolved ticket instantly) and negative
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
          const legalAcceptance = decodeLegalAcceptance(
            settings?.legalAcceptance,
          );
          const rephraseModel =
            typeof settings?.rephraseModel === "string" &&
            settings.rephraseModel.length > 0
              ? settings.rephraseModel
              : null;
          const resolutionPolicy = decodeResolutionPolicy(
            settings?.resolutionPolicy,
          );
          // Default-true: only an explicit `false` disables restock-on-cancel.
          // Absent (older rows / never configured) ⇒ restock, the safe default
          // for stores that track inventory.
          const cancellationRestock = settings?.cancellationRestock !== false;
          const blockedSenders = decodeBlockedSenders(
            settings?.blockedSenders,
          );
          // Null for an unconfigured or half-written block — agents then fall
          // back to knowledge.search for the delivery window.
          const shippingFacts = decodeShippingFacts(settings?.shippingFacts);
          // Null for an unconfigured or half-written block — agents then fall
          // back to knowledge.search for the return policy.
          const returnsFacts = decodeReturnsFacts(settings?.returnsFacts);
          return new TenantSettings({
            notificationEmail,
            refundPolicy,
            discountPolicy,
            retentionDays,
            supplierEscalationSheet,
            legalAcceptance,
            rephraseModel,
            cancellationRestock,
            resolutionPolicy,
            blockedSenders,
            shippingFacts,
            returnsFacts,
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

      setDiscountPolicy: (tenantId, policy) =>
        Effect.gen(function* () {
          const db = yield* pickDb;
          // Same shallow `||` JSONB merge as setRefundPolicy — replaces the
          // `discountPolicy` block, leaves every sibling setting untouched.
          const policyJson = JSON.stringify({ discountPolicy: policy });
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
                operation: "setDiscountPolicy",
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

      setLegalAcceptance: (tenantId, acceptance) =>
        Effect.gen(function* () {
          const db = yield* pickDb;
          const acceptanceJson = JSON.stringify({
            legalAcceptance: acceptance,
          });
          const result = yield* Effect.tryPromise({
            try: () =>
              db
                .update(tenants)
                .set({
                  settings: sql`${tenants.settings} || ${acceptanceJson}::jsonb`,
                })
                .where(eq(tenants.id, tenantId))
                .returning({ id: tenants.id }),
            catch: (cause) =>
              new TenantRepositoryDbError({
                operation: "setLegalAcceptance",
                cause,
              }),
          });
          if (result.length === 0) {
            return yield* Effect.fail(new TenantNotFound({ tenantId }));
          }
        }),

      setRephraseModel: (tenantId, model) =>
        Effect.gen(function* () {
          const db = yield* pickDb;
          // Same shallow `||` merge as the other setters. `null` writes the
          // JSONB null literal, which getSettings decodes back to null (== use
          // the built-in default).
          const modelJson = JSON.stringify({ rephraseModel: model });
          const result = yield* Effect.tryPromise({
            try: () =>
              db
                .update(tenants)
                .set({
                  settings: sql`${tenants.settings} || ${modelJson}::jsonb`,
                })
                .where(eq(tenants.id, tenantId))
                .returning({ id: tenants.id }),
            catch: (cause) =>
              new TenantRepositoryDbError({
                operation: "setRephraseModel",
                cause,
              }),
          });
          if (result.length === 0) {
            return yield* Effect.fail(new TenantNotFound({ tenantId }));
          }
        }),

      setCancellationRestock: (tenantId, restock: boolean) =>
        Effect.gen(function* () {
          const db = yield* pickDb;
          // Same shallow `||` JSONB merge as the other setters — replaces the
          // `cancellationRestock` flag, leaves every sibling setting untouched.
          const json = JSON.stringify({ cancellationRestock: restock });
          const result = yield* Effect.tryPromise({
            try: () =>
              db
                .update(tenants)
                .set({
                  settings: sql`${tenants.settings} || ${json}::jsonb`,
                })
                .where(eq(tenants.id, tenantId))
                .returning({ id: tenants.id }),
            catch: (cause) =>
              new TenantRepositoryDbError({
                operation: "setCancellationRestock",
                cause,
              }),
          });
          if (result.length === 0) {
            return yield* Effect.fail(new TenantNotFound({ tenantId }));
          }
        }),

      setResolutionPolicy: (tenantId, policy: ResolutionPolicy) =>
        Effect.gen(function* () {
          const db = yield* pickDb;
          // Same shallow `||` JSONB merge as setRefundPolicy — replaces the
          // `resolutionPolicy` block, leaves every sibling setting untouched.
          const policyJson = JSON.stringify({ resolutionPolicy: policy });
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
                operation: "setResolutionPolicy",
                cause,
              }),
          });
          if (result.length === 0) {
            return yield* Effect.fail(new TenantNotFound({ tenantId }));
          }
        }),

      setBlockedSenders: (tenantId, blocked: BlockedSenders) =>
        Effect.gen(function* () {
          const db = yield* pickDb;
          // Same shallow `||` JSONB merge as setRefundPolicy — replaces the
          // `blockedSenders` block, leaves every sibling setting untouched.
          const json = JSON.stringify({ blockedSenders: blocked });
          const result = yield* Effect.tryPromise({
            try: () =>
              db
                .update(tenants)
                .set({
                  settings: sql`${tenants.settings} || ${json}::jsonb`,
                })
                .where(eq(tenants.id, tenantId))
                .returning({ id: tenants.id }),
            catch: (cause) =>
              new TenantRepositoryDbError({
                operation: "setBlockedSenders",
                cause,
              }),
          });
          if (result.length === 0) {
            return yield* Effect.fail(new TenantNotFound({ tenantId }));
          }
        }),

      setShippingFacts: (tenantId, facts: ShippingFacts | null) =>
        Effect.gen(function* () {
          const db = yield* pickDb;
          // Same shallow `||` JSONB merge as setRefundPolicy. A `null` block
          // writes JSON null, which `decodeShippingFacts` reads back as
          // "unconfigured" — that's the clear action.
          const json = JSON.stringify({ shippingFacts: facts });
          const result = yield* Effect.tryPromise({
            try: () =>
              db
                .update(tenants)
                .set({
                  settings: sql`${tenants.settings} || ${json}::jsonb`,
                })
                .where(eq(tenants.id, tenantId))
                .returning({ id: tenants.id }),
            catch: (cause) =>
              new TenantRepositoryDbError({
                operation: "setShippingFacts",
                cause,
              }),
          });
          if (result.length === 0) {
            return yield* Effect.fail(new TenantNotFound({ tenantId }));
          }
        }),

      setReturnsFacts: (tenantId, facts: ReturnsFacts | null) =>
        Effect.gen(function* () {
          const db = yield* pickDb;
          // Same shallow `||` JSONB merge as setShippingFacts. A `null` block
          // writes JSON null, which `decodeReturnsFacts` reads back as
          // "unconfigured" — the clear action.
          const json = JSON.stringify({ returnsFacts: facts });
          const result = yield* Effect.tryPromise({
            try: () =>
              db
                .update(tenants)
                .set({
                  settings: sql`${tenants.settings} || ${json}::jsonb`,
                })
                .where(eq(tenants.id, tenantId))
                .returning({ id: tenants.id }),
            catch: (cause) =>
              new TenantRepositoryDbError({
                operation: "setReturnsFacts",
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
