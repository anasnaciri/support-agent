import { Context, Data, Effect, Layer } from "effect";
import {
  hammingDistance,
  type TicketId,
  type TenantId,
} from "@support-agent/agent-core";

/**
 * Persistence + nearest-neighbour lookup for perceptual image hashes. Backs
 * the damaged-product duplicate-photo fraud guard: every customer photo's
 * dHash is recorded, and each new photo is checked against the tenant's
 * recent hashes for a near-match (small Hamming distance).
 */

export interface RecordImageHashInput {
  readonly tenantId: TenantId;
  readonly ticketId: TicketId;
  readonly phash: bigint;
  /**
   * Canonical Shopify order GID this photo belongs to, when the ticket's order
   * is already identified. Usually null at ingestion (the order is resolved
   * later, by `get_order`) and backfilled onto the row via `bindOrder`.
   */
  readonly orderId?: string | null;
}

export interface BindOrderInput {
  readonly tenantId: TenantId;
  readonly ticketId: TicketId;
  /** The canonical order GID to stamp onto the ticket's un-bound hash rows. */
  readonly orderId: string;
}

export interface ListPhashesInput {
  readonly tenantId: TenantId;
  readonly ticketId: TicketId;
}

export interface FindSimilarInput {
  readonly tenantId: TenantId;
  /** The current ticket — excluded from results so a photo never matches itself. */
  readonly ticketId: TicketId;
  readonly phash: bigint;
  /**
   * The current ticket's identified order GID, when known. A stored hash bound
   * to this SAME order is NOT a duplicate — one damaged order can legitimately
   * carry the same photo across a follow-up. Only a hash linked to a DIFFERENT
   * order (or an un-bound one, which we can't clear) counts as a hit.
   */
  readonly orderId?: string | null;
  /** Inclusive Hamming-distance threshold for a "match" (typically 5). */
  readonly maxDistance: number;
  /** Only consider hashes recorded within this many days (typically 90). */
  readonly sinceDays: number;
  /** Override "now" for deterministic tests. */
  readonly now?: Date;
}

export interface SimilarImageHit {
  readonly ticketId: TicketId;
  readonly phash: bigint;
  readonly distance: number;
  readonly orderId: string | null;
}

export class ImageHashStoreDbError extends Data.TaggedError(
  "ImageHashStoreDbError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export type ImageHashStoreError = ImageHashStoreDbError;

export class ImageHashStore extends Context.Tag("ImageHashStore")<
  ImageHashStore,
  {
    readonly record: (
      input: RecordImageHashInput,
    ) => Effect.Effect<void, ImageHashStoreError>;
    readonly findSimilar: (
      input: FindSimilarInput,
    ) => Effect.Effect<ReadonlyArray<SimilarImageHit>, ImageHashStoreError>;
    /**
     * Stamp `orderId` onto the ticket's hash rows that don't yet carry one.
     * Called once the ticket's order is identified so future same-order lookups
     * can be suppressed. Only fills NULLs — a row already bound to an order is
     * left as-is.
     */
    readonly bindOrder: (
      input: BindOrderInput,
    ) => Effect.Effect<void, ImageHashStoreError>;
    /** The perceptual hashes recorded for a single ticket (for re-checking once the order is known). */
    readonly listPhashesForTicket: (
      input: ListPhashesInput,
    ) => Effect.Effect<ReadonlyArray<bigint>, ImageHashStoreError>;
  }
>() {}

interface StoredHash {
  readonly tenantId: TenantId;
  readonly ticketId: TicketId;
  readonly phash: bigint;
  readonly orderId: string | null;
  readonly createdAt: Date;
}

/**
 * Pure matcher shared by the Test layer and the Live layer (which fetches
 * the candidate window from Postgres, then filters here). Returns hits
 * within `maxDistance`, nearest first, excluding the originating ticket.
 */
export const matchSimilar = (
  rows: ReadonlyArray<StoredHash>,
  input: FindSimilarInput,
): ReadonlyArray<SimilarImageHit> => {
  const now = input.now ?? new Date();
  const cutoff = now.getTime() - input.sinceDays * 24 * 60 * 60 * 1000;
  const hits: SimilarImageHit[] = [];
  for (const row of rows) {
    if (row.tenantId !== input.tenantId) continue;
    if (row.ticketId === input.ticketId) continue;
    if (row.createdAt.getTime() < cutoff) continue;
    // Same order → not a duplicate (a follow-up on the one damaged order can
    // legitimately reuse the photo). Only suppress when BOTH sides know the
    // order and they match; an un-bound row stays conservative and can hit.
    if (
      input.orderId != null &&
      row.orderId != null &&
      row.orderId === input.orderId
    ) {
      continue;
    }
    const distance = hammingDistance(row.phash, input.phash);
    if (distance <= input.maxDistance) {
      hits.push({
        ticketId: row.ticketId,
        phash: row.phash,
        distance,
        orderId: row.orderId,
      });
    }
  }
  return hits.sort((a, b) => a.distance - b.distance);
};

export const ImageHashStoreTest = Layer.effect(
  ImageHashStore,
  Effect.sync(() => {
    const rows: StoredHash[] = [];
    return ImageHashStore.of({
      record: (input) =>
        Effect.sync(() => {
          rows.push({
            tenantId: input.tenantId,
            ticketId: input.ticketId,
            phash: input.phash,
            orderId: input.orderId ?? null,
            createdAt: new Date(),
          });
        }),
      findSimilar: (input) => Effect.sync(() => matchSimilar(rows, input)),
      bindOrder: (input) =>
        Effect.sync(() => {
          for (let i = 0; i < rows.length; i++) {
            const r = rows[i]!;
            if (
              r.tenantId === input.tenantId &&
              r.ticketId === input.ticketId &&
              r.orderId == null
            ) {
              rows[i] = { ...r, orderId: input.orderId };
            }
          }
        }),
      listPhashesForTicket: (input) =>
        Effect.sync(() =>
          rows
            .filter(
              (r) =>
                r.tenantId === input.tenantId && r.ticketId === input.ticketId,
            )
            .map((r) => r.phash),
        ),
    });
  }),
);
