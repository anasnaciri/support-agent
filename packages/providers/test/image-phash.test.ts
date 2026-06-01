import { describe, expect, it } from "vitest";
import { dhashFromLuma } from "@support-agent/agent-core";
import { computeImagePHash, type LumaDecoder } from "../src/image-phash.js";

// A 9x8 luma grid with a known pattern so we can assert the hash matches
// dhashFromLuma over the same input.
const grid = (): number[] => {
  const g: number[] = [];
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 9; x += 1) g.push((x * 31 + y * 7) % 256);
  }
  return g;
};

describe("computeImagePHash", () => {
  it("hashes the decoded luma grid (matches dhashFromLuma)", async () => {
    const luma = grid();
    const decode: LumaDecoder = () =>
      Promise.resolve({ width: 9, height: 8, luma });
    const hash = await computeImagePHash(new Uint8Array([1]), decode);
    expect(hash).toBe(dhashFromLuma(luma, 9, 8));
    expect(typeof hash).toBe("bigint");
  });

  it("returns null when the decoder yields null (undecodable bytes)", async () => {
    const hash = await computeImagePHash(
      new Uint8Array([0]),
      () => Promise.resolve(null),
    );
    expect(hash).toBeNull();
  });

  it("returns null (never throws) when the decoder rejects", async () => {
    const hash = await computeImagePHash(new Uint8Array([0]), () =>
      Promise.reject(new Error("not an image")),
    );
    expect(hash).toBeNull();
  });
});
