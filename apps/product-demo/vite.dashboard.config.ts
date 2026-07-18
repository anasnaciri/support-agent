import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: fileURLToPath(new URL("./site-src", import.meta.url)),
  base: "./",
  plugins: [react(), tailwindcss()],
  define: {
    "import.meta.env.VITE_API_BASE_URL": JSON.stringify(
      "https://demo.example.test",
    ),
  },
  resolve: {
    alias: {
      "@/app.css": fileURLToPath(
        new URL("./site-src/app-entry.css", import.meta.url),
      ),
      "@": fileURLToPath(new URL("../dashboard-spa", import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL("./site", import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
  },
});
