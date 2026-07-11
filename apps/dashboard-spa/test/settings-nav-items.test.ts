import { describe, expect, it } from "vitest";

import {
  SETTINGS_NAV_GROUPS,
  activeSettingsHref,
  visibleSettingsGroups,
} from "../lib/settings-nav-items";

const flatItems = SETTINGS_NAV_GROUPS.flatMap((group) => group.items);

describe("settings nav items", () => {
  it("does not expose the old permissions matrix", () => {
    expect(flatItems.some((item) => item.href === "/settings/permissions")).toBe(
      false,
    );
    expect(activeSettingsHref("/settings/permissions")).toBeNull();
  });

  it("exposes Agent at the singular agent settings route", () => {
    expect(flatItems.find((item) => item.href === "/settings/agent")?.label).toBe(
      "Agent",
    );
  });

  it("marks agent subpaths active under the agent nav item", () => {
    expect(activeSettingsHref("/settings/agent")).toBe("/settings/agent");
    expect(activeSettingsHref("/settings/agent/model")).toBe("/settings/agent");
  });

  it("exposes Scenarios at the scenarios settings route", () => {
    expect(
      flatItems.find((item) => item.href === "/settings/scenarios")?.label,
    ).toBe("Scenarios");
  });

  it("marks scenarios subpaths active under the scenarios nav item", () => {
    expect(activeSettingsHref("/settings/scenarios")).toBe("/settings/scenarios");
    expect(activeSettingsHref("/settings/scenarios/custom")).toBe(
      "/settings/scenarios",
    );
  });

  it("splits Knowledge base into Docs and Facts sub-items", () => {
    const knowledge = flatItems.find((item) => item.label === "Knowledge base");
    expect(knowledge?.children?.map((child) => child.label)).toEqual([
      "Docs",
      "Facts",
    ]);
    expect(knowledge?.children?.map((child) => child.href)).toEqual([
      "/settings/knowledge",
      "/settings/facts",
    ]);
  });

  it("marks the sub-item — not its parent — active", () => {
    // A doc's own page still highlights Docs; the store facts live on their own
    // route, so the two never light up together.
    expect(activeSettingsHref("/settings/knowledge")).toBe("/settings/knowledge");
    expect(activeSettingsHref("/settings/knowledge/doc-1")).toBe(
      "/settings/knowledge",
    );
    expect(activeSettingsHref("/settings/facts")).toBe("/settings/facts");
  });

  it("hides the whole Knowledge base section from a member without knowledge.view", () => {
    const groups = visibleSettingsGroups(new Set(["settings.agents"]));
    const items = groups.flatMap((group) => group.items);
    expect(items.some((item) => item.label === "Knowledge base")).toBe(false);
    expect(items.some((item) => item.href === "/settings/agent")).toBe(true);
  });
});
