import { describe, expect, it } from "vitest";
import { dhashFromLuma, hammingDistance } from "../src/index.js";

// A 9x8 luma grid where every row strictly increases left→right: each
// adjacent comparison (left > right) is false → all 64 bits are 0.
const ascendingRow = (): number[] => {
  const grid: number[] = [];
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 9; x += 1) grid.push(x * 10);
  }
  return grid;
};

// Strictly decreasing left→right: every comparison true → all 64 bits 1.
const descendingRow = (): number[] => {
  const grid: number[] = [];
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 9; x += 1) grid.push(80 - x * 10);
  }
  return grid;
};

describe("dhashFromLuma", () => {
  it("produces all-zero bits for a left→right ascending grid", () => {
    expect(dhashFromLuma(ascendingRow())).toBe(0n);
  });

  it("produces all-one bits (signed -1) for a descending grid", () => {
    // 64 ones, interpreted as a signed 64-bit integer, is -1.
    expect(dhashFromLuma(descendingRow())).toBe(-1n);
  });

  it("is stable for identical input", () => {
    const grid = ascendingRow();
    grid[0] = 100; // make the first comparison (100 > 10) true → bit 0 set
    const a = dhashFromLuma(grid);
    const b = dhashFromLuma(grid.slice());
    expect(a).toBe(b);
    expect(a & 1n).toBe(1n);
  });
});

describe("hammingDistance", () => {
  it("is 0 for identical hashes", () => {
    expect(hammingDistance(123456789n, 123456789n)).toBe(0);
    expect(hammingDistance(-1n, -1n)).toBe(0);
  });

  it("counts differing bits", () => {
    expect(hammingDistance(0n, 0b1011n)).toBe(3);
    expect(hammingDistance(0b1111n, 0b1010n)).toBe(2);
  });

  it("handles the full 64-bit range including the sign bit", () => {
    // 0 vs -1 (all 64 bits set) differ in all 64 positions.
    expect(hammingDistance(0n, -1n)).toBe(64);
  });
});
