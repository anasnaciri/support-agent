import { describe, expect, it } from "vitest";

import {
  SETTINGS_NAV_GROUPS,
  activeSettingsHref,
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
});
