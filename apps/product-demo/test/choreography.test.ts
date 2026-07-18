import { describe, expect, it } from "vitest";

import {
  cameraAt,
  cameraFrames,
  cueProgress,
  dashboardPointToScreen,
  deliveryStatusAt,
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
    expect(plateAt(16.5)).toBe("reassurance-sent");
  });

  it("gives each shipment state its own emphatic story beat", () => {
    expect(deliveryStatusAt(11)?.label).toBe("Undelivered");
    expect(deliveryStatusAt(36)?.label).toBe("In transit");
    expect(deliveryStatusAt(41)?.label).toBe("Delivered");
    expect(deliveryStatusAt(20)).toBeNull();
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

  it("moves directly from the message close-up into the ticket context", () => {
    const sidebarArrival = cameraAt(4.65);
    expect(sidebarArrival).toMatchObject({ x: -520, y: 280, scale: 1.55 });

    const movingToSidebar = cameraAt(4.1);
    expect(movingToSidebar.x).toBeLessThan(728);
    expect(movingToSidebar.x).toBeGreaterThan(-520);
    expect(movingToSidebar.scale).toBeGreaterThanOrEqual(1.5);

    expect(
      cameraFrames.some(
        (frame) =>
          frame.time > 3.55 && frame.time < 4.65 && frame.scale === 1,
      ),
    ).toBe(false);

    for (const time of [4.65, 8.35, 10.35]) {
      const camera = cameraAt(time);
      const topLeft = dashboardPointToScreen({ x: 0, y: 0 }, camera);
      const bottomRight = dashboardPointToScreen(
        { x: 1920, y: 1080 },
        camera,
      );
      expect(topLeft.x).toBeLessThanOrEqual(0);
      expect(topLeft.y).toBeLessThanOrEqual(0);
      expect(bottomRight.x).toBeGreaterThanOrEqual(1920);
      expect(bottomRight.y).toBeGreaterThanOrEqual(1080);
    }
  });

  it("uses smooth ease-out camera moves without spring-like overshoot", () => {
    expect(cameraAt(4.65).x).toBe(-520);

    expect(cameraAt(8).y).toBeLessThan(120);
    expect(cameraAt(8).y).toBeGreaterThan(0);
    expect(cameraAt(8.35).y).toBe(0);

    expect(cameraAt(9.9).y).toBeLessThan(0);
    expect(cameraAt(9.9).y).toBeGreaterThan(-290);
    expect(cameraAt(10.35).y).toBe(-290);
    expect(
      cameraFrames
        .filter((frame) => [4.65, 8.35, 10.35].includes(frame.time))
        .map((frame) => frame.ease),
    ).toEqual(["easeOutQuad", "easeOutQuad", "easeOutQuad"]);

    const movingFrames = cameraFrames.filter((frame, index) => {
      const previous = cameraFrames[index - 1];
      return (
        previous &&
        (frame.x !== previous.x ||
          frame.y !== previous.y ||
          frame.scale !== previous.scale)
      );
    });
    expect(
      movingFrames.every((frame) => frame.ease?.startsWith("easeOut")),
    ).toBe(true);

    const approveCue = visibleCursorCues[0];
    const halfway = (approveCue.start + approveCue.arrive) / 2;
    expect(cueProgress(halfway, approveCue).movement).toBeGreaterThan(0.8);
  });
});
