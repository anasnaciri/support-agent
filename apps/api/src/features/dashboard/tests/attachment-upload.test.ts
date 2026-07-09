import { describe, expect, it } from "vitest";
import {
  MAX_ATTACHMENT_BYTES,
  uploadStorageKey,
  validateAttachmentUpload,
} from "../attachment-upload.js";

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("body"),
]);
const pdf = Buffer.from("%PDF-1.7 fake");
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);

describe("validateAttachmentUpload", () => {
  it("accepts a PNG whose bytes match the declared type", () => {
    const v = validateAttachmentUpload({
      filename: " damage.png ",
      contentType: "image/png",
      bytes: png,
    });
    expect(v).toEqual({
      ok: true,
      filename: "damage.png",
      contentType: "image/png",
      ext: "png",
    });
  });

  it("accepts PDF and JPEG, and strips content-type parameters", () => {
    expect(
      validateAttachmentUpload({
        filename: "label.pdf",
        contentType: "application/pdf; charset=binary",
        bytes: pdf,
      }).ok,
    ).toBe(true);
    expect(
      validateAttachmentUpload({
        filename: "photo.jpg",
        contentType: "IMAGE/JPEG",
        bytes: jpeg,
      }).ok,
    ).toBe(true);
  });

  it("rejects types off the allowlist", () => {
    const v = validateAttachmentUpload({
      filename: "run.exe",
      contentType: "application/octet-stream",
      bytes: png,
    });
    expect(v).toEqual({ ok: false, error: "unsupported_type" });
  });

  it("rejects bytes that don't match the declared type (no lying)", () => {
    const v = validateAttachmentUpload({
      filename: "notreally.png",
      contentType: "image/png",
      bytes: pdf,
    });
    expect(v).toEqual({ ok: false, error: "content_mismatch" });
  });

  it("rejects empty and oversized bodies", () => {
    expect(
      validateAttachmentUpload({
        filename: "x.png",
        contentType: "image/png",
        bytes: Buffer.alloc(0),
      }),
    ).toEqual({ ok: false, error: "empty_body" });
    const big = Buffer.concat([png, Buffer.alloc(MAX_ATTACHMENT_BYTES)]);
    expect(
      validateAttachmentUpload({
        filename: "x.png",
        contentType: "image/png",
        bytes: big,
      }),
    ).toEqual({ ok: false, error: "too_large" });
  });

  it("requires a filename", () => {
    expect(
      validateAttachmentUpload({
        filename: "  ",
        contentType: "image/png",
        bytes: png,
      }),
    ).toEqual({ ok: false, error: "missing_filename" });
  });
});

describe("uploadStorageKey", () => {
  it("namespaces by tenant + ticket + upload id", () => {
    expect(uploadStorageKey("t-1", "tk-2", "u-3", "pdf")).toBe(
      "upload/t-1/tk-2/u-3.pdf",
    );
  });
});
