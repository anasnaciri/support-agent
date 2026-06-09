import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/**/test/**/*.test.ts",
      "apps/**/test/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
    passWithNoTests: true,
    reporters: ["default"],
    // Backstop that deletes any tenant created during the run (cascades to
    // children) after the whole suite. See vitest.global-teardown.ts.
    globalSetup: ["./vitest.global-teardown.ts"],
  },
});
