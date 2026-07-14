import { describe, expect, it } from "vitest";

import { HAND_BACK_OPTIONS } from "../lib/hand-back-options";

// The "Hand back to the agent" dialog (ticket-page Bot button) must set
// expectations honestly: handing back does NOT run the agent — it either waits
// for the customer's next message (parked, not "processing") or retries the
// last step right now. Two options, wait first (it's the safe default).
describe("HAND_BACK_OPTIONS", () => {
  it("offers exactly wait-for-reply then retry-last-step", () => {
    expect(HAND_BACK_OPTIONS.map((o) => o.key)).toEqual(["wait", "retry"]);
  });

  it("the wait option says nothing runs until the customer replies", () => {
    const wait = HAND_BACK_OPTIONS.find((o) => o.key === "wait");
    expect(wait?.label).toBe("Wait for the customer's reply");
    expect(wait?.description).toMatch(/next message|customer replies/i);
  });

  it("the retry option says the agent re-runs right away", () => {
    const retry = HAND_BACK_OPTIONS.find((o) => o.key === "retry");
    expect(retry?.label).toBe("Retry last step");
    expect(retry?.description).toMatch(/right away|now/i);
  });
});
