import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./apps/dashboard-spa", import.meta.url)),
    },
  },
  test: {
    include: [
      "packages/**/test/**/*.test.ts",
      "apps/**/test/**/*.test.ts",
      // apps/api co-locates its tests next to the code under src/**/tests/.
      "apps/**/src/**/*.test.ts",
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      // apps/dashboard (Next.js) is obsolete — superseded by apps/dashboard-spa.
      "apps/dashboard/**",
    ],
    passWithNoTests: true,
    reporters: ["default"],
    // Backstop that deletes any tenant created during the run (cascades to
    // children) after the whole suite. See vitest.global-teardown.ts.
    globalSetup: ["./vitest.global-teardown.ts"],
  },
});
