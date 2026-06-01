import { dhashFromLuma } from "@support-agent/agent-core";

/**
 * Decode raw image bytes into a small grayscale (luma) grid for hashing.
 * Injectable so `computeImagePHash`'s glue is testable without a real codec.
 */
export interface DecodedLuma {
  readonly width: number;
  readonly height: number;
  readonly luma: ReadonlyArray<number>;
}
export type LumaDecoder = (bytes: Uint8Array) => Promise<DecodedLuma | null>;

// dHash grid: 9 wide × 8 tall → exactly 64 adjacent-pixel comparisons.
const PHASH_W = 9;
const PHASH_H = 8;

const jimpDecode: LumaDecoder = async (bytes) => {
  // Loaded lazily so `jimp` (a heavy, codec-bearing dep that references
  // node `zlib`/`fs`) stays out of the static module graph — importing
  // `@support-agent/providers` from a bundler (e.g. the Next dashboard
  // transpiling this package) must not pull jimp in. Only the worker's
  // upload path ever reaches here.
  const { Jimp } = await import("jimp");
  const image = await Jimp.read(Buffer.from(bytes));
  // Downscale to the hash grid and flatten to grayscale; after greyscale()
  // R == G == B, so the red channel is the luma value.
  image.resize({ w: PHASH_W, h: PHASH_H }).greyscale();
  const { data, width, height } = image.bitmap;
  const luma: number[] = new Array<number>(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const px = (y * width + x) * 4;
      luma[y * width + x] = data[px] ?? 0;
    }
  }
  return { width, height, luma };
};

/**
 * Compute a 64-bit perceptual (difference) hash of an image. Returns the
 * signed-bigint hash, or `null` when the bytes can't be decoded (not an
 * image, corrupt, unsupported codec) — never throws, so a bad attachment
 * just yields no duplicate signal rather than breaking the upload.
 */
export const computeImagePHash = async (
  bytes: Uint8Array,
  decode: LumaDecoder = jimpDecode,
): Promise<bigint | null> => {
  try {
    const decoded = await decode(bytes);
    if (!decoded) return null;
    return dhashFromLuma(decoded.luma, decoded.width, decoded.height);
  } catch {
    return null;
  }
};
