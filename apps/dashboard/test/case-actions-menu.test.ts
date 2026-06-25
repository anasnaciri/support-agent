import { describe, expect, it } from "vitest";

import { caseActionMenuItems } from "../app/cases/[id]/case-actions-menu";

describe("caseActionMenuItems", () => {
  it("is empty when the case can't be resumed", () => {
    expect(caseActionMenuItems({ canResume: false })).toEqual([]);
  });

  it("offers Retry now while under human takeover (canResume)", () => {
    const items = caseActionMenuItems({ canResume: true });
    expect(items.map((i) => i.key)).toEqual(["retryNow"]);
    expect(items[0]).toMatchObject({
      key: "retryNow",
      label: "Retry now",
      pendingLabel: "Retrying…",
    });
  });
});
