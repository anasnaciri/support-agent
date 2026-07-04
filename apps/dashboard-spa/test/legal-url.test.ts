import { describe, expect, it } from "vitest";

import { deriveDataProcessingNoticeUrl } from "../lib/legal";

// Regression test for the dead "View notice" button: the Next port kept
// reading process.env.DASHBOARD_API_BASE_URL (a server-only var, always
// undefined in the Vite browser bundle), so the notice URL was always null.
// The SPA derives it from the same base the api-client transport uses.
describe("deriveDataProcessingNoticeUrl", () => {
  it("derives the api-hosted notice URL from the api base", () => {
    expect(deriveDataProcessingNoticeUrl("https://api.example.com")).toBe(
      "https://api.example.com/legal/data-processing",
    );
  });

  it("normalises trailing slashes and whitespace", () => {
    expect(deriveDataProcessingNoticeUrl(" https://api.example.com/ ")).toBe(
      "https://api.example.com/legal/data-processing",
    );
  });

  it("uses the origin only, dropping any path on the base", () => {
    expect(
      deriveDataProcessingNoticeUrl("https://api.example.com/some/path"),
    ).toBe("https://api.example.com/legal/data-processing");
  });

  it("returns null when the base is missing, empty, or not a URL", () => {
    expect(deriveDataProcessingNoticeUrl(undefined)).toBeNull();
    expect(deriveDataProcessingNoticeUrl("")).toBeNull();
    expect(deriveDataProcessingNoticeUrl("   ")).toBeNull();
    expect(deriveDataProcessingNoticeUrl("not a url")).toBeNull();
  });
});
