import { describe, expect, it } from "vitest";
import { summarizePhotoSignals, type MessageAttachment } from "../src/index.js";

const img = (
  name: string,
  hasExif: boolean | null,
): MessageAttachment => ({
  filename: name,
  contentType: "image/jpeg",
  storageKey: `k/${name}`,
  sizeBytes: 100,
  ...(hasExif === null
    ? {}
    : {
        exif: {
          hasExif,
          cameraMake: hasExif ? "Apple" : null,
          cameraModel: null,
          dateTimeOriginal: null,
          gps: null,
        },
      }),
});

const pdf: MessageAttachment = {
  filename: "invoice.pdf",
  contentType: "application/pdf",
  storageKey: "k/invoice.pdf",
  sizeBytes: 100,
};

describe("summarizePhotoSignals", () => {
  it("returns null when there are no image attachments", () => {
    expect(summarizePhotoSignals([])).toBeNull();
    expect(summarizePhotoSignals([pdf])).toBeNull();
  });

  it("counts only image attachments and ignores non-images", () => {
    const signals = summarizePhotoSignals([img("a.jpg", true), pdf]);
    expect(signals).toEqual({
      count: 1,
      withExif: 1,
      stripped: 0,
      anyStripped: false,
    });
  });

  it("flags any stripped image", () => {
    const signals = summarizePhotoSignals([
      img("a.jpg", true),
      img("b.jpg", false),
    ]);
    expect(signals).toEqual({
      count: 2,
      withExif: 1,
      stripped: 1,
      anyStripped: true,
    });
  });

  it("treats an attachment with no exif field as stripped", () => {
    const signals = summarizePhotoSignals([img("a.jpg", null)]);
    expect(signals).toEqual({
      count: 1,
      withExif: 0,
      stripped: 1,
      anyStripped: true,
    });
  });
});
