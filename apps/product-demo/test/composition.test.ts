import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";

const compositionPath = fileURLToPath(
  new URL("../index.html", import.meta.url),
);
const compositionCssPath = fileURLToPath(
  new URL("../composition.css", import.meta.url),
);
const dashboardCssPath = fileURLToPath(
  new URL("../site-src/demo-dashboard.css", import.meta.url),
);

const loadComposition = async (): Promise<Document> => {
  const html = await readFile(compositionPath, "utf8");
  return new JSDOM(html).window.document;
};

describe("HyperFrames support-resolution composition", () => {
  it("exposes a 1080p 45-second composition with both product portals", async () => {
    const document = await loadComposition();

    const root = document.querySelector("[data-composition-id]");
    expect(root?.getAttribute("data-composition-id")).toBe(
      "support-resolution-demo",
    );
    expect(root?.getAttribute("data-duration")).toBe("45");
    expect(root?.getAttribute("data-fps")).toBe("60");
    expect(root?.getAttribute("data-width")).toBe("1920");
    expect(root?.getAttribute("data-height")).toBe("1080");
    expect(document.querySelector("[data-portal='merchant']")).not.toBeNull();
    expect(
      document.querySelector("[data-portal='fulfillment-operator']"),
    ).not.toBeNull();

    const plates = [
      ...document.querySelectorAll<HTMLIFrameElement>(
        "iframe[data-dashboard-state]",
      ),
    ];
    expect(plates).toHaveLength(12);
    expect(
      plates.every((plate) => plate.src.includes("./site/index.html?")),
    ).toBe(true);
    expect(
      plates.every((plate) => plate.title.includes("actual dashboard")),
    ).toBe(true);
    expect(plates.some((plate) => plate.src.includes("view=list"))).toBe(true);
    expect(plates.some((plate) => plate.src.includes("view=detail"))).toBe(
      true,
    );
    expect(
      plates
        .map((plate) => plate.getAttribute("data-dashboard-state"))
        .slice(0, 5),
    ).toEqual([
      "customer-message",
      "agent-investigation-empty",
      "agent-investigation-customer",
      "agent-investigation-order",
      "agent-investigation",
    ]);
    expect(
      plates.some(
        (plate) =>
          plate.getAttribute("data-dashboard-state") === "reassurance-sent",
      ),
    ).toBe(true);
  });

  it("contains every visible state in the merchant-to-fulfillment story", async () => {
    const document = await loadComposition();
    const requiredShots = [
      "customer-message",
      "processing-status",
      "customer-context",
      "order-context",
      "tracking-context",
      "approval-bundle",
      "fulfillment-escalation",
      "partner-update",
      "tracking-edit",
      "customer-update",
      "time-jump",
      "delivered-status",
      "happy-reply",
    ];

    for (const shot of requiredShots) {
      expect(
        document.querySelector(`[data-shot='${shot}']`),
        `missing ${shot}`,
      ).not.toBeNull();
    }

    expect(document.querySelector("[data-camera]")).not.toBeNull();
    const cursor = document.querySelector<HTMLImageElement>(
      "img[data-demo-cursor]",
    );
    expect(cursor?.getAttribute("src")).toBe("./assets/macos-default.svg");
    expect(document.querySelector("[data-composer-beam]")).not.toBeNull();
    expect(document.querySelector("[data-portal-handoff]")).not.toBeNull();
    expect(document.querySelector("[data-partner-view-label]")).not.toBeNull();
    expect(document.querySelector("[data-delivery-status]")).not.toBeNull();
    expect(document.querySelector("[data-cursor-click]")).toBeNull();
  });

  it("uses a high-contrast beam and suppresses demo-only focus rings", async () => {
    const [compositionCss, dashboardCss] = await Promise.all([
      readFile(compositionCssPath, "utf8"),
      readFile(dashboardCssPath, "utf8"),
    ]);

    expect(compositionCss).toContain("--beam-strength: 1");
    expect(compositionCss).toContain("0 0 64px");
    expect(compositionCss).not.toContain(".cursor span");
    expect(dashboardCss).toContain("focus-within\\:ring-2:focus-within");
    expect(dashboardCss).toContain("focus-visible\\:ring-2:focus-visible");
    expect(dashboardCss).toContain("--tw-ring-shadow: 0 0 #0000");
  });
});
