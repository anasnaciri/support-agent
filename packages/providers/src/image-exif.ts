import type { ExifSummary } from "@support-agent/agent-core";

/**
 * Parse the EXIF block out of raw image bytes. Returns the translated
 * fields we care about (Make/Model/DateTimeOriginal + GPS lat/lon) or
 * `undefined` when the image has no parseable metadata. Injectable so the
 * mapping logic in `extractImageExif` can be tested without real images.
 */
export type ExifParse = (
  bytes: Uint8Array,
) => Promise<Record<string, unknown> | undefined>;

const EMPTY: ExifSummary = {
  hasExif: false,
  cameraMake: null,
  cameraModel: null,
  dateTimeOriginal: null,
  gps: null,
};

const trimmed = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const toIso = (value: unknown): string | null => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  return trimmed(value);
};

const finiteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

// Real parser: tiff (ifd0 → Make/Model), exif (DateTimeOriginal), and gps
// with `gps: true` so the GPS IFD is translated into decimal
// latitude/longitude rather than raw rational arrays.
const defaultParse: ExifParse = async (bytes) => {
  // Lazily imported (same rationale as jimp in image-phash.ts) so `exifr`
  // stays out of any bundler's static graph for `@support-agent/providers`.
  const { default: exifr } = await import("exifr");
  return exifr.parse(bytes, { tiff: true, exif: true, gps: true }) as Promise<
    Record<string, unknown> | undefined
  >;
};

/**
 * Build a privacy-conscious {@link ExifSummary} from image bytes. The
 * headline `hasExif` is true when any camera-identifying field is present;
 * originals from a phone/camera carry these, while screenshots, AI-gen
 * images, and stripped stock photos do not. Never throws — a malformed or
 * non-image input collapses to the empty summary so the upload pipeline is
 * unaffected.
 */
export const extractImageExif = async (
  bytes: Uint8Array,
  parse: ExifParse = defaultParse,
): Promise<ExifSummary> => {
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = await parse(bytes);
  } catch {
    return EMPTY;
  }
  if (!parsed || typeof parsed !== "object") return EMPTY;

  const cameraMake = trimmed(parsed["Make"]);
  const cameraModel = trimmed(parsed["Model"]);
  const dateTimeOriginal = toIso(parsed["DateTimeOriginal"]);
  const lat = finiteNumber(parsed["latitude"]);
  const lon = finiteNumber(parsed["longitude"]);
  const gps = lat !== null && lon !== null ? { lat, lon } : null;

  const hasExif =
    cameraMake !== null ||
    cameraModel !== null ||
    dateTimeOriginal !== null ||
    gps !== null;

  return { hasExif, cameraMake, cameraModel, dateTimeOriginal, gps };
};
