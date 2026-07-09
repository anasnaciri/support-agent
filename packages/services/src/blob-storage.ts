import { Context, Effect, Layer } from "effect";
import {
  BlobNotFound,
  type BlobStorageError,
  type TenantId,
} from "@support-agent/agent-core";

/**
 * Per-process BlobStorage config. Production resolves these from R2_*
 * env vars at worker bootstrap; tests skip this Tag entirely (the Test
 * layer has no config). Held as a separate Tag (rather than baked into
 * a single Live factory) so the worker can compose Layers without
 * pulling env reads into the Layer graph at module load time.
 */
export class BlobStorageConfig extends Context.Tag("BlobStorageConfig")<
  BlobStorageConfig,
  {
    readonly bucket: string;
    readonly endpoint: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    /**
     * The public URL prefix the LLM provider sees when we presign a GET
     * URL. For Cloudflare R2 with a custom domain this is `https://blobs.example.com`;
     * with the bare R2 endpoint it falls back to the `endpoint` value.
     * Optional — defaults to `endpoint`.
     */
    readonly publicUrlBase?: string;
    /**
     * R2's region is always `auto`. Kept as a config field so a future
     * S3-backed deployment can supply a real region without code changes.
     */
    readonly region?: string;
  }
>() {}

/**
 * Input for `BlobStorage.put`. `tenantId` is recorded so the Live impl
 * can scope deletions / lifecycle policies per tenant; keys are NOT
 * implicitly namespaced — callers compose the full key (e.g.
 * `gmail/{tenantId}/{messageId}/{attachmentId}.png`).
 */
export interface BlobPutInput {
  readonly tenantId: TenantId;
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

export interface BlobGetResult {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/**
 * Provider-neutral binary storage Tag. Production Live impl is
 * Cloudflare R2 (S3-compatible). Tools and the runtime never reach the
 * underlying client; everything goes through this Tag so unit tests can
 * drive `BlobStorageTest` and the same code runs against R2 in
 * production.
 *
 * `presignGetUrl` returns a time-limited URL that callers (or
 * downstream services like the LLM provider, when we don't want to
 * stream bytes through ourselves) can use to fetch the object
 * directly. Today the only Live impl is R2 — a future Supabase /
 * filesystem layer would implement the same shape.
 *
 * `delete` is IDEMPOTENT: removing a key that isn't there succeeds.
 * Retention sweeps re-run over the same keys after a partial failure,
 * and an already-gone blob is the outcome they wanted.
 */
export class BlobStorage extends Context.Tag("BlobStorage")<
  BlobStorage,
  {
    readonly put: (
      input: BlobPutInput,
    ) => Effect.Effect<void, BlobStorageError>;
    readonly get: (
      key: string,
    ) => Effect.Effect<BlobGetResult, BlobStorageError>;
    readonly presignGetUrl: (
      key: string,
      ttlSeconds: number,
    ) => Effect.Effect<string, BlobStorageError>;
    readonly delete: (key: string) => Effect.Effect<void, BlobStorageError>;
  }
>() {}

// ============================================================
// Test layer — in-memory, deterministic
// ============================================================

export interface BlobTestFixtures {
  /** Seed objects keyed by storage key. */
  readonly seed?: Readonly<Record<string, BlobGetResult>>;
  /** Full override for `put`. */
  readonly put?: (
    input: BlobPutInput,
  ) => Effect.Effect<void, BlobStorageError>;
  /** Full override for `get`. */
  readonly get?: (
    key: string,
  ) => Effect.Effect<BlobGetResult, BlobStorageError>;
  /** Full override for `presignGetUrl`. */
  readonly presignGetUrl?: (
    key: string,
    ttlSeconds: number,
  ) => Effect.Effect<string, BlobStorageError>;
  /** Full override for `delete`. */
  readonly delete?: (key: string) => Effect.Effect<void, BlobStorageError>;
}

/**
 * In-memory `BlobStorage` for unit tests. Stores blobs in a Map keyed by
 * storage key. `presignGetUrl` synthesises a `memory://<key>` URL so
 * tests can assert URL shape without a real signer; the URL is only
 * meaningful in test code. Pass overrides to force specific failure
 * shapes (e.g. `BlobStorageFailed`).
 */
export const BlobStorageTest = (fixtures: BlobTestFixtures = {}) => {
  const store = new Map<string, BlobGetResult>(
    Object.entries(fixtures.seed ?? {}),
  );
  return Layer.succeed(
    BlobStorage,
    BlobStorage.of({
      put: (input) => {
        if (fixtures.put) return fixtures.put(input);
        store.set(input.key, {
          bytes: input.bytes,
          contentType: input.contentType,
        });
        return Effect.void;
      },
      get: (key) => {
        if (fixtures.get) return fixtures.get(key);
        const hit = store.get(key);
        if (!hit) return Effect.fail(new BlobNotFound({ key }));
        return Effect.succeed(hit);
      },
      presignGetUrl: (key, ttlSeconds) => {
        if (fixtures.presignGetUrl)
          return fixtures.presignGetUrl(key, ttlSeconds);
        if (!store.has(key)) return Effect.fail(new BlobNotFound({ key }));
        return Effect.succeed(`memory://${key}?ttl=${ttlSeconds}`);
      },
      delete: (key) => {
        if (fixtures.delete) return fixtures.delete(key);
        // Idempotent, like the R2 impl: a missing key is not an error.
        store.delete(key);
        return Effect.void;
      },
    }),
  );
};
