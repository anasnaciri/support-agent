import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Vite SPA build for the merchant dashboard (port of apps/dashboard).
// - `@` aliases the package root so copied components/libs keep their
//   `@/lib/*` and `@/components/*` imports verbatim (mirrors the Next app's
//   `@/* -> ./*` path map).
// - Tailwind v4 via the Vite plugin (no PostCSS/config file — CSS-first).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  server: { port: 3001 },
  preview: { port: 3001 },
  build: { outDir: "dist", sourcemap: true },
});
