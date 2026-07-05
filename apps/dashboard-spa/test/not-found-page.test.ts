import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const spaFile = (path: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../${path}`, import.meta.url)),
    "utf8",
  );

describe("not-found page", () => {
  it("uses a dedicated 404 fallback with a return-home link", () => {
    const routerSource = spaFile("router.tsx");
    const notFoundSource = spaFile("features/not-found/NotFoundPage.tsx");

    expect(routerSource).toContain('import { NotFoundPage } from "@/features/not-found/NotFoundPage"');
    expect(routerSource).toContain("defaultNotFoundComponent: NotFoundPage");
    expect(notFoundSource).toContain("404");
    expect(notFoundSource).toContain('href="/"');
  });
});
