import { Effect, FiberRef, Layer } from "effect";
import { and, eq, gte, ne } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  ImageHashStore,
  ImageHashStoreDbError,
  matchSimilar,
  type FindSimilarInput,
  type ImageHashStoreError,
  type RecordImageHashInput,
  type SimilarImageHit,
} from "@support-agent/services";
import {
  TicketId as makeTicketId,
  TenantId as makeTenantId,
} from "@support-agent/agent-core";
import { CurrentTxRef, DbClient } from "./db-client.js";
import type { DrizzleDb } from "./client.js";
import { imageHashes } from "./schema.js";

const useDb = (defaultDb: DrizzleDb): Effect.Effect<DrizzleDb> =>
  FiberRef.get(CurrentTxRef).pipe(Effect.map((tx) => tx ?? defaultDb));

const wrap = <A>(
  operation: string,
  promise: Promise<A>,
): Effect.Effect<A, ImageHashStoreDbError> =>
  Effect.tryPromise({
    try: () => promise,
    catch: (cause) => new ImageHashStoreDbError({ operation, cause }),
  });

export const ImageHashStoreLive = Layer.effect(
  ImageHashStore,
  Effect.gen(function* () {
    const defaultDb = yield* DbClient;

    const record = (
      input: RecordImageHashInput,
    ): Effect.Effect<void, ImageHashStoreError> =>
      Effect.gen(function* () {
        const db = yield* useDb(defaultDb);
        yield* wrap(
          "record",
          db.insert(imageHashes).values({
            id: randomUUID(),
            tenantId: input.tenantId,
            ticketId: input.ticketId,
            phash: input.phash,
          }),
        );
      });

    const findSimilar = (
      input: FindSimilarInput,
    ): Effect.Effect<ReadonlyArray<SimilarImageHit>, ImageHashStoreError> =>
      Effect.gen(function* () {
        const db = yield* useDb(defaultDb);
        const now = input.now ?? new Date();
        const cutoff = new Date(
          now.getTime() - input.sinceDays * 24 * 60 * 60 * 1000,
        );
        // Narrow to the tenant's recent window in SQL (uses the
        // tenant_created index); the Hamming-distance filter + sort runs in
        // `matchSimilar` so the matching logic is identical to the Test
        // layer. At today's volumes the window is small; a SQL `bit_count`
        // pushdown is the optimisation if it ever grows.
        const rows = yield* wrap(
          "findSimilar",
          db
            .select()
            .from(imageHashes)
            .where(
              and(
                eq(imageHashes.tenantId, input.tenantId),
                gte(imageHashes.createdAt, cutoff),
                ne(imageHashes.ticketId, input.ticketId),
              ),
            ),
        );
        return matchSimilar(
          rows.map((r) => ({
            tenantId: makeTenantId(r.tenantId),
            ticketId: makeTicketId(r.ticketId),
            phash: r.phash,
            createdAt: r.createdAt,
          })),
          input,
        );
      });

    return ImageHashStore.of({ record, findSimilar });
  }),
);
