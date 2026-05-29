import { Effect, Layer } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BlobNotFound,
  BlobStorageFailed,
  TenantId,
} from "@support-agent/agent-core";
import { BlobStorage, BlobStorageConfig } from "@support-agent/services";

// ---------- Module mocks -----------------------------------------------------

// `send` lives on the S3Client instance; commands are plain shape objects
// the SDK serializes. We capture every send call so tests can assert what
// the live impl sent, and return a fixture from a per-test `nextResponse`.
const sendMock = vi.fn();
const presignMock = vi.fn();

vi.mock("@aws-sdk/client-s3", () => {
  class FakeS3Client {
    public readonly config: unknown;
    public readonly send: typeof sendMock;
    constructor(cfg: unknown) {
      this.config = cfg;
      this.send = sendMock;
    }
  }
  class PutObjectCommand {
    public readonly input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
    public readonly __kind = "PutObject" as const;
  }
  class GetObjectCommand {
    public readonly input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
    public readonly __kind = "GetObject" as const;
  }
  return { S3Client: FakeS3Client, PutObjectCommand, GetObjectCommand };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: (...args: ReadonlyArray<unknown>) =>
    presignMock(...args) as unknown,
}));

const { BlobStorageLive } = await import("../src/blob-storage-live.js");

// ---------- Test fixtures ----------------------------------------------------

const tenantId = TenantId("00000000-0000-0000-0000-000000000001");

const cfgLayer = Layer.succeed(
  BlobStorageConfig,
  BlobStorageConfig.of({
    bucket: "evidence",
    endpoint: "https://acct.r2.cloudflarestorage.com",
    accessKeyId: "AKIA-FAKE",
    secretAccessKey: "secret-fake",
  }),
);

const liveLayer = BlobStorageLive.pipe(Layer.provide(cfgLayer));

const run = <A, E>(eff: Effect.Effect<A, E, BlobStorage>) =>
  Effect.runPromiseExit(Effect.provide(eff, liveLayer));

beforeEach(() => {
  sendMock.mockReset();
  presignMock.mockReset();
});

// ---------- put -------------------------------------------------------------

describe("BlobStorageLive — put", () => {
  it("issues a PutObjectCommand with bucket, key, body, content type, and tenant metadata", async () => {
    sendMock.mockResolvedValueOnce({});
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const exit = await run(
      Effect.flatMap(BlobStorage, (s) =>
        s.put({
          tenantId,
          key: "gmail/t/m/att1.jpg",
          bytes,
          contentType: "image/jpeg",
        }),
      ),
    );
    expect(exit._tag).toBe("Success");
    expect(sendMock).toHaveBeenCalledOnce();
    const cmd = sendMock.mock.calls[0]![0] as {
      __kind: string;
      input: {
        Bucket: string;
        Key: string;
        Body: Uint8Array;
        ContentType: string;
        Metadata: Record<string, string>;
      };
    };
    expect(cmd.__kind).toBe("PutObject");
    expect(cmd.input.Bucket).toBe("evidence");
    expect(cmd.input.Key).toBe("gmail/t/m/att1.jpg");
    expect(cmd.input.Body).toBe(bytes);
    expect(cmd.input.ContentType).toBe("image/jpeg");
    expect(cmd.input.Metadata["tenant-id"]).toBe(tenantId);
  });

  it("maps an unknown S3 failure to BlobStorageFailed", async () => {
    sendMock.mockRejectedValueOnce(
      Object.assign(new Error("AccessDenied"), {
        name: "AccessDenied",
        $metadata: { httpStatusCode: 403 },
      }),
    );
    const exit = await run(
      Effect.flatMap(BlobStorage, (s) =>
        s.put({
          tenantId,
          key: "x",
          bytes: new Uint8Array([1]),
          contentType: "image/png",
        }),
      ),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    if (exit.cause._tag !== "Fail") throw new Error("expected Fail cause");
    expect(exit.cause.error).toBeInstanceOf(BlobStorageFailed);
  });
});

// ---------- get -------------------------------------------------------------

describe("BlobStorageLive — get", () => {
  it("reads bytes via transformToByteArray and surfaces contentType", async () => {
    const fixtureBytes = new Uint8Array([7, 8, 9]);
    sendMock.mockResolvedValueOnce({
      Body: {
        transformToByteArray: async () => fixtureBytes,
      },
      ContentType: "image/png",
    });
    const exit = await run(
      Effect.flatMap(BlobStorage, (s) => s.get("gmail/t/m/att.png")),
    );
    expect(exit._tag).toBe("Success");
    if (exit._tag !== "Success") return;
    expect(exit.value.bytes).toBe(fixtureBytes);
    expect(exit.value.contentType).toBe("image/png");

    const cmd = sendMock.mock.calls[0]![0] as {
      __kind: string;
      input: { Bucket: string; Key: string };
    };
    expect(cmd.__kind).toBe("GetObject");
    expect(cmd.input.Bucket).toBe("evidence");
    expect(cmd.input.Key).toBe("gmail/t/m/att.png");
  });

  it("maps NoSuchKey errors to BlobNotFound", async () => {
    sendMock.mockRejectedValueOnce(
      Object.assign(new Error("not found"), {
        name: "NoSuchKey",
        $metadata: { httpStatusCode: 404 },
      }),
    );
    const exit = await run(
      Effect.flatMap(BlobStorage, (s) => s.get("missing")),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    if (exit.cause._tag !== "Fail") throw new Error("expected Fail cause");
    expect(exit.cause.error).toBeInstanceOf(BlobNotFound);
  });

  it("maps a generic transport failure to BlobStorageFailed", async () => {
    sendMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    const exit = await run(
      Effect.flatMap(BlobStorage, (s) => s.get("any")),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    if (exit.cause._tag !== "Fail") throw new Error("expected Fail cause");
    expect(exit.cause.error).toBeInstanceOf(BlobStorageFailed);
  });

  it("falls back to application/octet-stream when the SDK omits ContentType", async () => {
    sendMock.mockResolvedValueOnce({
      Body: { transformToByteArray: async () => new Uint8Array([0]) },
    });
    const exit = await run(
      Effect.flatMap(BlobStorage, (s) => s.get("k")),
    );
    expect(exit._tag).toBe("Success");
    if (exit._tag !== "Success") return;
    expect(exit.value.contentType).toBe("application/octet-stream");
  });
});

// ---------- presignGetUrl ---------------------------------------------------

describe("BlobStorageLive — presignGetUrl", () => {
  it("delegates to getSignedUrl with the GetObject command and expiresIn", async () => {
    presignMock.mockResolvedValueOnce(
      "https://acct.r2.cloudflarestorage.com/evidence/k?X-Amz-...",
    );
    const exit = await run(
      Effect.flatMap(BlobStorage, (s) => s.presignGetUrl("k", 600)),
    );
    expect(exit._tag).toBe("Success");
    if (exit._tag !== "Success") return;
    expect(exit.value.startsWith("https://acct.r2.cloudflarestorage.com")).toBe(
      true,
    );
    expect(presignMock).toHaveBeenCalledOnce();
    const args = presignMock.mock.calls[0]!;
    const cmd = args[1] as { __kind: string; input: { Key: string } };
    const opts = args[2] as { expiresIn: number };
    expect(cmd.__kind).toBe("GetObject");
    expect(cmd.input.Key).toBe("k");
    expect(opts.expiresIn).toBe(600);
  });

  it("surfaces presign failures as BlobStorageFailed", async () => {
    presignMock.mockRejectedValueOnce(new Error("signer broken"));
    const exit = await run(
      Effect.flatMap(BlobStorage, (s) => s.presignGetUrl("k", 60)),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    if (exit.cause._tag !== "Fail") throw new Error("expected Fail cause");
    expect(exit.cause.error).toBeInstanceOf(BlobStorageFailed);
  });
});
