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
}

export interface FindSimilarInput {
  readonly tenantId: TenantId;
  /** The current ticket — excluded from results so a photo never matches itself. */
  readonly ticketId: TicketId;
  readonly phash: bigint;
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
  }
>() {}

interface StoredHash {
  readonly tenantId: TenantId;
  readonly ticketId: TicketId;
  readonly phash: bigint;
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
    const distance = hammingDistance(row.phash, input.phash);
    if (distance <= input.maxDistance) {
      hits.push({ ticketId: row.ticketId, phash: row.phash, distance });
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
          rows.push({ ...input, createdAt: new Date() });
        }),
      findSimilar: (input) => Effect.sync(() => matchSimilar(rows, input)),
    });
  }),
);
