import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { ConversationSendFailed } from "@support-agent/agent-core";
import { BlobStorage, BlobStorageTest } from "@support-agent/services";
import {
  encodeBase64Lines,
  resolveOutboundAttachments,
  sanitizeMimeFilename,
} from "../src/outbound-attachments.js";
import { buildGmailMime } from "../src/gmail-http.js";

const runWithBlob = <A, E>(
  seed: Record<string, { bytes: Uint8Array; contentType: string }>,
  body: (blob: typeof BlobStorage.Service) => Effect.Effect<A, E>,
) =>
  Effect.runPromiseExit(
    Effect.provide(
      Effect.gen(function* () {
        const blob = yield* BlobStorage;
        return yield* body(blob);
      }),
      BlobStorageTest({ seed }),
    ),
  );

describe("resolveOutboundAttachments", () => {
  const photoBytes = new Uint8Array([1, 2, 3, 4]);

  it("resolves storage keys to bytes, preserving order and metadata", async () => {
    const exit = await runWithBlob(
      {
        "upload/t/1/a.png": { bytes: photoBytes, contentType: "image/png" },
        "upload/t/1/b.pdf": {
          bytes: new Uint8Array([9]),
          contentType: "application/pdf",
        },
      },
      (blob) =>
        resolveOutboundAttachments(
          blob,
          [
            {
              filename: "label.pdf",
              contentType: "application/pdf",
              storageKey: "upload/t/1/b.pdf",
              sizeBytes: 1,
            },
            {
              filename: "photo.png",
              contentType: "image/png",
              storageKey: "upload/t/1/a.png",
              sizeBytes: 4,
            },
          ],
          "draft-1",
        ),
    );
    expect(exit._tag).toBe("Success");
    if (exit._tag === "Success") {
      expect(exit.value.map((a) => a.filename)).toEqual([
        "label.pdf",
        "photo.png",
      ]);
      expect(exit.value[1]?.bytes).toEqual(photoBytes);
    }
  });

  it("fails the send (ConversationSendFailed) when a blob is missing", async () => {
    const exit = await runWithBlob({}, (blob) =>
      resolveOutboundAttachments(
        blob,
        [
          {
            filename: "gone.png",
            contentType: "image/png",
            storageKey: "upload/t/1/missing.png",
            sizeBytes: 4,
          },
        ],
        "draft-2",
      ),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(ConversationSendFailed);
      expect((exit.cause.error as ConversationSendFailed).draftId).toBe(
        "draft-2",
      );
    }
  });
});

describe("encodeBase64Lines / sanitizeMimeFilename", () => {
  it("wraps base64 at 76 chars and round-trips the bytes", () => {
    const bytes = new Uint8Array(200).map((_, i) => i % 251);
    const encoded = encodeBase64Lines(bytes);
    for (const line of encoded.split("\r\n")) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
    expect(new Uint8Array(Buffer.from(encoded, "base64"))).toEqual(bytes);
  });

  it("neutralises header-breaking characters in filenames", () => {
    expect(sanitizeMimeFilename('a"b\r\nc.png')).toBe("a_b__c.png");
    expect(sanitizeMimeFilename("  ")).toBe("attachment");
  });
});

describe("buildGmailMime with attachments", () => {
  it("emits multipart/mixed wrapping the body and base64 attachment parts", () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const raw = buildGmailMime({
      from: { name: null, email: "support@merchant.com" },
      to: [{ name: "Ana", email: "ana@example.com" }],
      subject: "Re: order",
      bodyText: "See attached label.",
      bodyHtml: "<p>See attached label.</p>",
      attachments: [
        {
          filename: "label.pdf",
          contentType: "application/pdf",
          bytes,
        },
      ],
    });
    const decoded = Buffer.from(
      raw.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    expect(decoded).toContain("Content-Type: multipart/mixed");
    // Body still present as an alternative part inside the mixed wrapper.
    expect(decoded).toContain("Content-Type: multipart/alternative");
    expect(decoded).toContain("See attached label.");
    expect(decoded).toContain(
      'Content-Type: application/pdf; name="label.pdf"',
    );
    expect(decoded).toContain(
      'Content-Disposition: attachment; filename="label.pdf"',
    );
    expect(decoded).toContain("Content-Transfer-Encoding: base64");
    expect(decoded).toContain(Buffer.from(bytes).toString("base64"));
  });

  it("keeps the plain single-part shape when there are no attachments", () => {
    const raw = buildGmailMime({
      from: { name: null, email: "support@merchant.com" },
      to: [{ name: null, email: "ana@example.com" }],
      subject: "Re: order",
      bodyText: "hello",
      bodyHtml: null,
    });
    const decoded = Buffer.from(
      raw.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    expect(decoded).not.toContain("multipart/mixed");
    expect(decoded).toContain('Content-Type: text/plain; charset="UTF-8"');
  });
});
