import { describe, expect, it } from "vitest";

import { strList } from "../server.js";

// The multi-select approvals filters ship repeated query keys. Fastify's parser
// gives a string for one key, a string[] for several, and undefined when
// absent — strList normalizes all three into a clean list.
describe("strList", () => {
  it("wraps a single string value", () => {
    expect(strList({ status: "pending" }, "status")).toEqual(["pending"]);
  });

  it("passes an array through, dropping empties and non-strings", () => {
    expect(strList({ risk: ["low", "", "high"] }, "risk")).toEqual([
      "low",
      "high",
    ]);
  });

  it("returns an empty list for an absent or empty key", () => {
    expect(strList({}, "tool")).toEqual([]);
    expect(strList({ tool: "" }, "tool")).toEqual([]);
  });
});
