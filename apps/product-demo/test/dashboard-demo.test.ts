import { describe, expect, it } from "vitest";

import { dashboardDemoPayload } from "../dashboard-demo-data";

describe("dashboard product-demo data", () => {
  it("reveals customer, order, and tracking context in separate investigation beats", () => {
    const emptyShopify = dashboardDemoPayload(
      "/dashboard/tickets/demo-ticket/shopify",
      "agent-investigation-empty",
    );
    const customerShopify = dashboardDemoPayload(
      "/dashboard/tickets/demo-ticket/shopify",
      "agent-investigation-customer",
    );
    const orderShopify = dashboardDemoPayload(
      "/dashboard/tickets/demo-ticket/shopify",
      "agent-investigation-order",
    );
    const tracking = dashboardDemoPayload(
      "/dashboard/tickets/demo-ticket/tracking",
      "agent-investigation",
    );

    expect(emptyShopify.body.customer).toBeNull();
    expect(emptyShopify.body.order).toBeNull();
    expect(customerShopify.body.customer?.email).toBe("maya@example.test");
    expect(customerShopify.body.order).toBeNull();
    expect(orderShopify.body.customer?.email).toBe("maya@example.test");
    expect(orderShopify.body.order?.name).toBe("#1048");
    expect(
      dashboardDemoPayload(
        "/dashboard/tickets/demo-ticket/tracking",
        "agent-investigation-order",
      ).body.kind,
    ).toBe("not_found");
    expect(tracking.body.kind).toBe("ok");
  });

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
    expect(
      detail.body.approvals.map((approval: { tool: string }) => approval.tool),
    ).toEqual(["conversation.reply", "fulfillment_operator.escalate"]);
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

  it("shows the reassuring customer reply before handing off to fulfillment", () => {
    const response = dashboardDemoPayload(
      "/dashboard/tickets/demo-ticket/conversation-thread",
      "reassurance-sent",
    );

    expect(response.status).toBe(200);
    expect(response.body.thread.messages).toHaveLength(2);
    expect(response.body.thread.messages[1]).toMatchObject({
      direction: "outbound",
      bodyText: expect.stringContaining(
        "checking this with our fulfillment partner",
      ),
    });
  });
});
