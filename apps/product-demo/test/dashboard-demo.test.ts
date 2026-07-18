import { describe, expect, it } from "vitest";

import { dashboardDemoPayload } from "../dashboard-demo-data";

describe("dashboard product-demo data", () => {
  it("grants the real fulfillment portal permission ids", () => {
    const response = dashboardDemoPayload(
      "/dashboard/fulfillment-operator/session",
      "fulfillment-resolution",
    );

    expect(response.status).toBe(200);
    expect(response.body.permissions).toContain(
      "fulfillment_operator.tickets.view",
    );
    expect(response.body.permissions).toContain(
      "fulfillment_operator.tickets.respond",
    );
  });

  it("renders the real ticket page with a two-action approval bundle", () => {
    const detail = dashboardDemoPayload(
      "/dashboard/tickets/demo-ticket",
      "merchant-approval",
    );

    expect(detail.status).toBe(200);
    expect(detail.body.ticket.status).toBe("waiting_for_approval");
    expect(detail.body.approvals).toHaveLength(2);
    expect(detail.body.approvals.map((approval: { tool: string }) => approval.tool)).toEqual([
      "conversation.reply",
      "fulfillment_operator.escalate",
    ]);
  });

  it("renders the existing fulfillment portal from the same synthetic order", () => {
    const detail = dashboardDemoPayload(
      "/dashboard/fulfillment-operator/tickets/demo-escalation",
      "fulfillment-resolution",
    );

    expect(detail.status).toBe(200);
    expect(detail.body.orderRef).toBe("#1048");
    expect(detail.body.problem).toContain("appears undelivered");
    expect(detail.body.trackingNumber).toBe("DEMO-9400-1048");
  });
});
