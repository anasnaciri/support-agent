import { describe, expect, it } from "vitest";

import {
  cameraAt,
  cueProgress,
  dashboardPointToScreen,
  openingMessageAnimationTime,
  openingMessageKeyframes,
  openingMessageOptions,
  plateAt,
  visibleCursorCues,
} from "../choreography.js";

describe("product-demo choreography", () => {
  it("starts on the message close-up and reveals context one card at a time", () => {
    expect(cameraAt(0).scale).toBeGreaterThanOrEqual(1.4);
    const messageCenter = dashboardPointToScreen(
      { x: 475, y: 145 },
      cameraAt(0),
    );
    expect(messageCenter.x).toBeCloseTo(960, -1);
    expect(messageCenter.y).toBeCloseTo(540, -1);

    expect(plateAt(0)).toBe("customer-message");
    expect(plateAt(4.5)).toBe("agent-investigation-empty");
    expect(plateAt(6.5)).toBe("agent-investigation-customer");
    expect(plateAt(8.5)).toBe("agent-investigation-order");
    expect(plateAt(10.5)).toBe("agent-investigation");
  });

  it("drives the opening bubble through the SPA's 350ms rise animation", () => {
    expect(openingMessageKeyframes).toEqual([
      { opacity: 0, transform: "translateY(14px)" },
      { opacity: 1, transform: "translateY(0)" },
    ]);
    expect(openingMessageOptions).toMatchObject({
      duration: 350,
      easing: "cubic-bezier(0.2, 0, 0, 1)",
      fill: "both",
    });
    expect(openingMessageAnimationTime(0)).toBe(0);
    expect(openingMessageAnimationTime(0.7)).toBe(0);
    expect(openingMessageAnimationTime(0.875)).toBeCloseTo(175);
    expect(openingMessageAnimationTime(1.05)).toBe(350);
  });

  it("anchors every visible click cue to a real dashboard element", () => {
    expect(visibleCursorCues.map((cue) => cue.target)).toEqual([
      "approve-bundle",
      "partner-ticket",
      "partner-note",
      "partner-submit",
      "customer-send",
    ]);
    expect(
      visibleCursorCues.every((cue) => !("x" in cue) && !("y" in cue)),
    ).toBe(true);
  });

  it("uses punchy overshoot and fast cursor easing instead of linear-feeling pans", () => {
    expect(cameraAt(4.85).x).toBe(0);
    expect(cameraAt(5.1).x).toBeLessThan(-650);
    expect(cameraAt(5.35).x).toBe(-650);

    const approveCue = visibleCursorCues[0];
    const halfway = (approveCue.start + approveCue.arrive) / 2;
    expect(cueProgress(halfway, approveCue).movement).toBeGreaterThan(0.8);
  });
});
