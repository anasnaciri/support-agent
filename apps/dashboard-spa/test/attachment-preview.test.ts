import { describe, expect, it } from "vitest";
import { attachmentPreviewKind } from "../lib/attachment-preview";

describe("attachmentPreviewKind", () => {
  it("previews images inline — that's the whole point of the lightbox", () => {
    expect(attachmentPreviewKind({ id: "a", contentType: "image/jpeg" })).toBe(
      "image",
    );
    expect(attachmentPreviewKind({ id: "a", contentType: "image/png" })).toBe(
      "image",
    );
    expect(attachmentPreviewKind({ id: "a", contentType: "image/webp" })).toBe(
      "image",
    );
  });

  it("ignores content-type parameters and casing", () => {
    expect(
      attachmentPreviewKind({ id: "a", contentType: "IMAGE/JPEG; charset=x" }),
    ).toBe("image");
  });

  it("offers a non-image file as a download, not a broken <img>", () => {
    expect(
      attachmentPreviewKind({ id: "a", contentType: "application/pdf" }),
    ).toBe("file");
  });

  it("is inert without an id — nothing to exchange for a signed URL", () => {
    // A connector reported the attachment but we never stored its bytes.
    expect(
      attachmentPreviewKind({ id: null, contentType: "image/jpeg" }),
    ).toBe("inert");
    expect(
      attachmentPreviewKind({ id: null, contentType: "application/pdf" }),
    ).toBe("inert");
  });

  it("treats an svg as a file, never an inline image", () => {
    // SVG is script-capable; it must never be rendered in an <img> we control
    // the surrounding page for. (It is also off the upload allowlist.)
    expect(
      attachmentPreviewKind({ id: "a", contentType: "image/svg+xml" }),
    ).toBe("file");
  });
});
