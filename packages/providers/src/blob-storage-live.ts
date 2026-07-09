import { Effect, Layer } from "effect";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  BlobNotFound,
  BlobStorageFailed,
  type BlobStorageError,
} from "@support-agent/agent-core";
import {
  BlobStorage,
  BlobStorageConfig,
  type BlobGetResult,
  type BlobPutInput,
} from "@support-agent/services";

/**
 * Live `BlobStorage` backed by Cloudflare R2 (S3-compatible). R2 quirks
 * worth knowing:
 *   - Region is always `auto`. The SDK still wants a value; pass it.
 *   - No bucket sub-domain routing — use a path-style endpoint, i.e. the
 *     `endpoint` field carries `https://<accountid>.r2.cloudflarestorage.com`
 *     and bucket goes into the request. We let the SDK handle that.
 *   - 404 on GetObject surfaces as `NoSuchKey` (a tagged AWS error) which
 *     we map to `BlobNotFound`. Anything else surfaces as `BlobStorageFailed`.
 */

const isNoSuchKey = (err: unknown): boolean => {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: unknown; $metadata?: { httpStatusCode?: number } };
  if (e.name === "NoSuchKey" || e.name === "NotFound") return true;
  if (e.$metadata?.httpStatusCode === 404) return true;
  return false;
};

const collectBody = async (
  body: unknown,
): Promise<Uint8Array> => {
  // `Body` on the GetObject response is one of: Readable (Node), Blob,
  // ReadableStream<Uint8Array>, string. The SDK exposes a
  // `transformToByteArray()` helper on it; prefer that, fall back to
  // streaming. Body is missing on a successful empty-object response —
  // treat that as zero bytes.
  if (!body) return new Uint8Array(0);
  const b = body as {
    transformToByteArray?: () => Promise<Uint8Array>;
    arrayBuffer?: () => Promise<ArrayBuffer>;
  };
  if (typeof b.transformToByteArray === "function") {
    return b.transformToByteArray();
  }
  if (typeof b.arrayBuffer === "function") {
    const ab = await b.arrayBuffer();
    return new Uint8Array(ab);
  }
  // Last resort: stringify (rarely hit in practice).
  return new TextEncoder().encode(String(body));
};

export const BlobStorageLive = Layer.effect(
  BlobStorage,
  Effect.gen(function* () {
    const cfg = yield* BlobStorageConfig;
    const clientCfg: S3ClientConfig = {
      region: cfg.region ?? "auto",
      endpoint: cfg.endpoint,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
      // R2 requires path-style addressing; the SDK defaults to virtual
      // host style otherwise.
      forcePathStyle: true,
    };
    const client = new S3Client(clientCfg);

    return BlobStorage.of({
      put: (input: BlobPutInput): Effect.Effect<void, BlobStorageError> =>
        Effect.tryPromise({
          try: async () => {
            await client.send(
              new PutObjectCommand({
                Bucket: cfg.bucket,
                Key: input.key,
                Body: input.bytes,
                ContentType: input.contentType,
                Metadata: { "tenant-id": String(input.tenantId) },
              }),
            );
          },
          catch: (cause) =>
            new BlobStorageFailed({ key: input.key, cause }),
        }),

      get: (key: string): Effect.Effect<BlobGetResult, BlobStorageError> =>
        Effect.tryPromise({
          try: async () => {
            const res = await client.send(
              new GetObjectCommand({ Bucket: cfg.bucket, Key: key }),
            );
            const bytes = await collectBody(res.Body);
            return {
              bytes,
              contentType: res.ContentType ?? "application/octet-stream",
            } satisfies BlobGetResult;
          },
          catch: (cause) =>
            isNoSuchKey(cause)
              ? new BlobNotFound({ key })
              : new BlobStorageFailed({ key, cause }),
        }),

      presignGetUrl: (
        key: string,
        ttlSeconds: number,
      ): Effect.Effect<string, BlobStorageError> =>
        Effect.tryPromise({
          try: () =>
            getSignedUrl(
              client,
              new GetObjectCommand({ Bucket: cfg.bucket, Key: key }),
              { expiresIn: ttlSeconds },
            ),
          catch: (cause) =>
            isNoSuchKey(cause)
              ? new BlobNotFound({ key })
              : new BlobStorageFailed({ key, cause }),
        }),

      // Idempotent: R2's DeleteObject already returns 204 for a key that isn't
      // there, but some S3-compatible impls 404 — either way a retried
      // retention sweep must not fail on a blob it deleted last pass.
      delete: (key: string): Effect.Effect<void, BlobStorageError> =>
        Effect.tryPromise({
          try: async () => {
            await client.send(
              new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }),
            );
          },
          catch: (cause) => ({ cause }),
        }).pipe(
          Effect.catchAll(({ cause }) =>
            isNoSuchKey(cause)
              ? Effect.void
              : Effect.fail(new BlobStorageFailed({ key, cause })),
          ),
        ),
    });
  }),
);

/**
 * Read R2 config from env. The four fields are all required when this
 * factory runs; missing any of them fails the Layer build at bootstrap.
 * Worker bootstrap gates on whether `R2_BUCKET` is present before
 * pulling this Layer in — when absent, it provides `BlobStorageTest`
 * instead so dev + tests work without R2.
 */
export const BlobStorageConfigFromEnv = Layer.effect(
  BlobStorageConfig,
  Effect.sync(() => {
    const bucket = process.env["R2_BUCKET"];
    const endpoint = process.env["R2_ENDPOINT"];
    const accessKeyId = process.env["R2_ACCESS_KEY_ID"];
    const secretAccessKey = process.env["R2_SECRET_ACCESS_KEY"];
    if (!bucket || !endpoint || !accessKeyId || !secretAccessKey) {
      throw new Error(
        "BlobStorageConfigFromEnv requires R2_BUCKET, R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY",
      );
    }
    const publicUrlBase = process.env["R2_PUBLIC_URL_BASE"];
    const region = process.env["R2_REGION"];
    return BlobStorageConfig.of({
      bucket,
      endpoint,
      accessKeyId,
      secretAccessKey,
      ...(publicUrlBase ? { publicUrlBase } : {}),
      ...(region ? { region } : {}),
    });
  }),
);
