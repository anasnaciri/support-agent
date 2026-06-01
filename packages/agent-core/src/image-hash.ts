/**
 * Perceptual image hashing utilities — pure, deterministic, dependency-free.
 *
 * Used by the damaged-product fraud guard: a difference-hash (dHash) of a
 * customer's photo is compared against hashes seen on other cases for the
 * same tenant. Two encodings of the SAME photo produce near-identical
 * hashes (small Hamming distance), so a re-used "broken item" image across
 * multiple orders is detectable without storing the image itself.
 *
 * The actual image decode/resize lives in `providers` (it needs a codec);
 * these functions operate on an already-extracted luma grid so the hashing
 * math is testable without real images.
 */

const SIXTY_FOUR_BIT_MASK = (1n << 64n) - 1n;

/**
 * Difference-hash of a `width × height` grayscale (luma) grid, row-major.
 * Each of the `(width - 1) × height` adjacent horizontal comparisons emits
 * one bit (`left > right`). With the default 9×8 grid that's exactly 64
 * bits, returned as a signed 64-bit BigInt so it round-trips losslessly
 * through a Postgres `bigint` column.
 */
export const dhashFromLuma = (
  luma: ReadonlyArray<number> | Uint8Array,
  width = 9,
  height = 8,
): bigint => {
  let bits = 0n;
  let bit = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const left = luma[y * width + x] ?? 0;
      const right = luma[y * width + x + 1] ?? 0;
      if (left > right) bits |= 1n << BigInt(bit);
      bit += 1;
    }
  }
  return BigInt.asIntN(64, bits);
};

/**
 * Number of differing bits between two 64-bit hashes. Operates on the
 * low 64 bits so signed/unsigned BigInt representations compare correctly.
 */
export const hammingDistance = (a: bigint, b: bigint): number => {
  let x = (a ^ b) & SIXTY_FOUR_BIT_MASK;
  let count = 0;
  while (x > 0n) {
    x &= x - 1n; // clear the lowest set bit
    count += 1;
  }
  return count;
};
