import { describe, expect, it } from "vitest";

import { DEMO_DATA, SUPPORT_DEMO_STORY, sceneAt } from "../story";

describe("support-resolution product demo story", () => {
  it("moves through the complete resolution arc on one continuous timeline", () => {
    expect(SUPPORT_DEMO_STORY.duration).toBe(45);
    expect(SUPPORT_DEMO_STORY.scenes.map((scene) => scene.id)).toEqual([
      "customer-message",
      "agent-investigation",
      "merchant-approval",
      "fulfillment-resolution",
      "customer-update",
      "delivered-delight",
    ]);

    expect(sceneAt(0).id).toBe("customer-message");
    expect(sceneAt(14).id).toBe("merchant-approval");
    expect(sceneAt(21).id).toBe("fulfillment-resolution");
    expect(sceneAt(44.99).id).toBe("delivered-delight");
  });

  it("uses one synthetic order through escalation, reshipment, and delivery", () => {
    expect(DEMO_DATA.customer.message).toBe("Hi, where is my order?");
    expect(DEMO_DATA.order.reference).toBe("#1048");
    expect(DEMO_DATA.order.initialTracking.status).toBe("Undelivered");
    expect(DEMO_DATA.order.reshipmentTracking.number).not.toBe(
      DEMO_DATA.order.initialTracking.number,
    );
    expect(DEMO_DATA.order.reshipmentTracking.status).toBe("In transit");
    expect(DEMO_DATA.order.finalStatus).toBe("Delivered");
    expect(DEMO_DATA.customer.happyReply).toContain("support was amazing");
  });
});
