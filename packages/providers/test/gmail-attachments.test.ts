import { describe, expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";
import { TenantId } from "@support-agent/agent-core";
import { BlobStorage, BlobStorageTest } from "@support-agent/services";
import {
  extractImageAttachments,
  gmailGetAttachment,
  processGmailImageAttachments,
  buildGmailAttachmentStorageKey,
} from "../src/index.js";

const b64url = (bytes: Uint8Array): string =>
  Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const okJson = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  }) as unknown as Response;

const tenantId = TenantId("11111111-1111-1111-1111-111111111111");

// ============================================================
// extractImageAttachments — pure part walker
// ============================================================

describe("extractImageAttachments", () => {
  it("returns image-only attachments with attachmentId + filename + size", () => {
    const result = extractImageAttachments({
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { data: "hi" } },
            { mimeType: "text/html", body: { data: "<p>hi</p>" } },
          ],
        },
        {
          mimeType: "image/jpeg",
          filename: "front.jpg",
          body: { attachmentId: "ATT_1", size: 12_345 },
        },
        {
          mimeType: "image/png",
          filename: "side.png",
          body: { attachmentId: "ATT_2", size: 8192 },
        },
        // non-image attachment — filtered out
        {
          mimeType: "application/pdf",
          filename: "invoice.pdf",
          body: { attachmentId: "ATT_3", size: 1024 },
        },
      ],
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      attachmentId: "ATT_1",
      filename: "front.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 12_345,
    });
    expect(result[1]?.attachmentId).toBe("ATT_2");
  });

  it("synthesises a filename when the part omits one", () => {
    const result = extractImageAttachments({
      mimeType: "image/jpeg",
      body: { attachmentId: "ATT_X", size: 10 },
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.filename).toBe("attachment-ATT_X");
  });

  it("returns an empty array when payload has no image parts", () => {
    expect(
      extractImageAttachments({
        mimeType: "text/plain",
        body: { data: "plain body" },
      }),
    ).toHaveLength(0);
  });

  it("returns an empty array when payload is undefined", () => {
    expect(extractImageAttachments(undefined)).toHaveLength(0);
  });
});

// ============================================================
// gmailGetAttachment — wire format
// ============================================================

describe("gmailGetAttachment", () => {
  it("calls the per-message attachments endpoint and decodes base64url bytes", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03]);
    const fetchImpl = vi.fn(async (url: string | URL) =>
      okJson({ data: b64url(bytes), size: bytes.byteLength }),
    );
    const result = await gmailGetAttachment({
      token: "tok-123",
      messageId: "msg-1",
      attachmentId: "ATT_1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const calledUrl = String(fetchImpl.mock.calls[0]![0]);
    expect(calledUrl).toContain(
      "/users/me/messages/msg-1/attachments/ATT_1",
    );
    expect(Array.from(result.bytes)).toEqual(Array.from(bytes));
    expect(result.size).toBe(bytes.byteLength);
  });

  it("throws when the response body omits the data field", async () => {
    const fetchImpl = vi.fn(async () => okJson({ size: 10 }));
    await expect(
      gmailGetAttachment({
        token: "tok-123",
        messageId: "msg-1",
        attachmentId: "ATT_1",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow();
  });
});

// ============================================================
// processGmailImageAttachments — upload pipeline
// ============================================================

describe("processGmailImageAttachments", () => {
  it("fetches each image, uploads to BlobStorage, returns MessageAttachment[] with storageKey", async () => {
    const bytesA = new Uint8Array([1, 2, 3]);
    const bytesB = new Uint8Array([4, 5, 6, 7]);
    const responses = [
      okJson({ data: b64url(bytesA), size: bytesA.byteLength }),
      okJson({ data: b64url(bytesB), size: bytesB.byteLength }),
    ];
    const fetchImpl = vi.fn(async () => responses.shift()!);

    const blobLayer = BlobStorageTest({});
    const blob = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          return yield* BlobStorage;
        }),
        blobLayer,
      ),
    );

    const result = await processGmailImageAttachments({
      tenantId,
      messageId: "msg-photo",
      token: "tok",
      imageAttachments: [
        {
          attachmentId: "A1",
          filename: "front.jpg",
          mimeType: "image/jpeg",
          sizeBytes: bytesA.byteLength,
        },
        {
          attachmentId: "A2",
          filename: "side.png",
          mimeType: "image/png",
          sizeBytes: bytesB.byteLength,
        },
      ],
      blob,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      filename: "front.jpg",
      contentType: "image/jpeg",
      storageKey: buildGmailAttachmentStorageKey(
        tenantId,
        "msg-photo",
        "A1",
        "image/jpeg",
      ),
      sizeBytes: bytesA.byteLength,
    });
    expect(result[1]?.storageKey.endsWith(".png")).toBe(true);

    // Verify the bytes actually landed in the store.
    const got = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const s = yield* BlobStorage;
          return yield* s.get(result[0]!.storageKey);
        }),
        blobLayer,
      ),
    );
    expect(Array.from(got.bytes)).toEqual(Array.from(bytesA));
  });

  it("skips an oversized attachment and keeps processing the rest", async () => {
    const bytesSmall = new Uint8Array([1, 2]);
    const fetchImpl = vi.fn(async () =>
      okJson({ data: b64url(bytesSmall), size: bytesSmall.byteLength }),
    );

    const blobLayer = BlobStorageTest({});
    const blob = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          return yield* BlobStorage;
        }),
        blobLayer,
      ),
    );

    const result = await processGmailImageAttachments({
      tenantId,
      messageId: "msg-photo",
      token: "tok",
      imageAttachments: [
        {
          attachmentId: "huge",
          filename: "huge.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 100 * 1024 * 1024, // 100 MiB — well above the cap
        },
        {
          attachmentId: "small",
          filename: "small.jpg",
          mimeType: "image/jpeg",
          sizeBytes: bytesSmall.byteLength,
        },
      ],
      blob,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.filename).toBe("small.jpg");
    // Only the small attachment was fetched — the huge one was rejected pre-fetch.
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("survives a failed Gmail fetch on one attachment by skipping it", async () => {
    const bytesOK = new Uint8Array([9, 9, 9]);
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        // first attachment: simulate Gmail 404
        return {
          ok: false,
          status: 404,
          json: async () => ({}),
          text: async () => "not found",
          headers: new Headers(),
        } as unknown as Response;
      }
      return okJson({ data: b64url(bytesOK), size: bytesOK.byteLength });
    });

    const blobLayer = BlobStorageTest({});
    const blob = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          return yield* BlobStorage;
        }),
        blobLayer,
      ),
    );

    const result = await processGmailImageAttachments({
      tenantId,
      messageId: "msg-photo",
      token: "tok",
      imageAttachments: [
        {
          attachmentId: "gone",
          filename: "gone.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 100,
        },
        {
          attachmentId: "here",
          filename: "here.jpg",
          mimeType: "image/jpeg",
          sizeBytes: bytesOK.byteLength,
        },
      ],
      blob,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.filename).toBe("here.jpg");
  });
});

describe("buildGmailAttachmentStorageKey", () => {
  it("composes a tenant-scoped key with a MIME-derived extension", () => {
    const key = buildGmailAttachmentStorageKey(
      tenantId,
      "msg-123",
      "ATT_X",
      "image/jpeg",
    );
    expect(key).toBe(`gmail/${tenantId}/msg-123/ATT_X.jpg`);
  });

  it("falls back to .bin for unknown MIME types", () => {
    const key = buildGmailAttachmentStorageKey(
      tenantId,
      "m",
      "a",
      "image/avif",
    );
    expect(key.endsWith(".bin")).toBe(true);
  });
});
