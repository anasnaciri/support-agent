import { describe, expect, it } from "vitest";
import { extractImageExif, type ExifParse } from "../src/image-exif.js";

const parserOf =
  (result: Record<string, unknown> | undefined): ExifParse =>
  () =>
    Promise.resolve(result);

const throwingParser: ExifParse = () =>
  Promise.reject(new Error("not a recognised image"));

describe("extractImageExif", () => {
  it("maps a full camera EXIF block to the summary", async () => {
    const captured = new Date("2026-05-20T14:30:00.000Z");
    const summary = await extractImageExif(
      new Uint8Array([1, 2, 3]),
      parserOf({
        Make: "Apple",
        Model: "iPhone 15 Pro",
        DateTimeOriginal: captured,
        latitude: 37.7749,
        longitude: -122.4194,
      }),
    );
    expect(summary).toEqual({
      hasExif: true,
      cameraMake: "Apple",
      cameraModel: "iPhone 15 Pro",
      dateTimeOriginal: "2026-05-20T14:30:00.000Z",
      gps: { lat: 37.7749, lon: -122.4194 },
    });
  });

  it("treats a stripped image (parser returns undefined) as no EXIF", async () => {
    const summary = await extractImageExif(
      new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      parserOf(undefined),
    );
    expect(summary.hasExif).toBe(false);
    expect(summary.cameraMake).toBeNull();
    expect(summary.cameraModel).toBeNull();
    expect(summary.dateTimeOriginal).toBeNull();
    expect(summary.gps).toBeNull();
  });

  it("treats an empty parse result as no EXIF", async () => {
    const summary = await extractImageExif(new Uint8Array([0]), parserOf({}));
    expect(summary.hasExif).toBe(false);
  });

  it("never throws when the parser rejects — returns empty summary", async () => {
    const summary = await extractImageExif(
      new Uint8Array([0]),
      throwingParser,
    );
    expect(summary.hasExif).toBe(false);
    expect(summary.gps).toBeNull();
  });

  it("counts a partial block (make only) as EXIF present", async () => {
    const summary = await extractImageExif(
      new Uint8Array([0]),
      parserOf({ Make: "Canon" }),
    );
    expect(summary.hasExif).toBe(true);
    expect(summary.cameraMake).toBe("Canon");
    expect(summary.cameraModel).toBeNull();
  });

  it("ignores partial GPS (latitude only) and blank strings", async () => {
    const summary = await extractImageExif(
      new Uint8Array([0]),
      parserOf({ Make: "   ", latitude: 37.0 }),
    );
    expect(summary.hasExif).toBe(false);
    expect(summary.cameraMake).toBeNull();
    expect(summary.gps).toBeNull();
  });

  it("accepts an ISO string DateTimeOriginal as-is", async () => {
    const summary = await extractImageExif(
      new Uint8Array([0]),
      parserOf({ DateTimeOriginal: "2026-01-02T03:04:05.000Z" }),
    );
    expect(summary.dateTimeOriginal).toBe("2026-01-02T03:04:05.000Z");
    expect(summary.hasExif).toBe(true);
  });
});
