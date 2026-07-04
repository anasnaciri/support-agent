import { describe, expect, it } from "vitest";

import { caseActionMenuItems } from "../lib/case-actions-menu";

describe("caseActionMenuItems", () => {
  it("is empty when the case can't be resumed", () => {
    expect(caseActionMenuItems({ canResume: false })).toEqual([]);
  });

  it("offers both retry shapes while under human takeover (canResume)", () => {
    const items = caseActionMenuItems({ canResume: true });
    // Retry the bound specialist's last step, OR retry the whole case from
    // triage so the agent re-classifies + re-routes from scratch.
    expect(items.map((i) => i.key)).toEqual(["retryNow", "retryFromTriage"]);
    expect(items[0]).toMatchObject({
      key: "retryNow",
      label: "Retry last step",
      pendingLabel: "Retrying…",
    });
    expect(items[1]).toMatchObject({
      key: "retryFromTriage",
      label: "Retry case",
      pendingLabel: "Restarting…",
    });
  });
});
