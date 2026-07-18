export type DashboardDemoState =
  | "customer-message"
  | "agent-investigation-empty"
  | "agent-investigation-customer"
  | "agent-investigation-order"
  | "agent-investigation"
  | "merchant-approval"
  | "reassurance-sent"
  | "fulfillment-resolution"
  | "customer-update"
  | "sent-update"
  | "delivered-delight";

interface DemoPayload {
  readonly status: number;
  readonly body: any;
}

const now = "2026-07-18T10:54:00.000Z";
const customerMessageAt = "2026-07-18T10:42:00.000Z";
const operatorEscalationAt = "2026-07-18T10:49:00.000Z";
const reassuranceSentAt = "2026-07-18T10:50:00.000Z";
const deliveredAt = "2026-07-21T14:18:00.000Z";

const reassurance =
  "I'm sorry about the delay. I'm checking this with our fulfillment partner now and will update you as soon as I have new tracking information.";
const escalation =
  "Order #1048 appears undelivered. Please confirm its status and reship if necessary.";
const customerUpdate =
  "Good news—your order has been reshipped. Your new tracking number is DEMO-1Z84-2048. We'll keep an eye on it until it arrives.";

const investigationStates: ReadonlySet<DashboardDemoState> = new Set([
  "agent-investigation-empty",
  "agent-investigation-customer",
  "agent-investigation-order",
  "agent-investigation",
]);

const ticketStatusFor = (state: DashboardDemoState): string => {
  if (state === "customer-message") return "new";
  if (investigationStates.has(state)) return "in_progress";
  if (state === "merchant-approval" || state === "customer-update") {
    return "waiting_for_approval";
  }
  if (state === "sent-update") return "waiting_for_customer";
  if (state === "delivered-delight") return "resolved";
  return "waiting_for_fulfillment_operator";
};

const approval = (id: string, tool: string, proposedInput: unknown) => ({
  id,
  ticketId: "demo-ticket",
  agentId: "order-status-agent",
  tool,
  proposedInput,
  approvedInput: null,
  reasoning: null,
  riskLevel: "medium",
  status: "pending",
  decidedBy: null,
  decidedAt: null,
  decisionReason: null,
  expiresAt: "2026-07-19T10:49:00.000Z",
  createdAt: operatorEscalationAt,
});

const approvalsFor = (state: DashboardDemoState) => {
  if (state === "merchant-approval") {
    return [
      approval("approval-reply", "conversation.reply", {
        to: "maya@example.test",
        bodyText: reassurance,
      }),
      approval("approval-escalation", "fulfillment_operator.escalate", {
        problem: escalation,
        orderRef: "#1048",
      }),
    ];
  }
  if (state === "customer-update") {
    return [
      approval("approval-update", "conversation.reply", {
        to: "maya@example.test",
        bodyText: customerUpdate,
      }),
    ];
  }
  return [];
};

const ticketContextFor = (state: DashboardDemoState) => {
  if (state === "customer-message" || state === "agent-investigation-empty") {
    return {};
  }
  if (state === "agent-investigation-customer") {
    return {
      customerEmail: "maya@example.test",
      customerName: "Maya Chen",
    };
  }
  return {
    customerEmail: "maya@example.test",
    customerName: "Maya Chen",
    quotedOrderRef: "#1048",
    identifiedOrderId: "#1048",
    notes: "Customer is asking for an update on order #1048.",
  };
};

const ticketDetail = (state: DashboardDemoState) => ({
  ticket: {
    id: "demo-ticket",
    subject: "Where is my order?",
    status: ticketStatusFor(state),
    scenarioKey: "order_status",
    currentAgentId: "order-status-agent",
    priority: "normal",
    summary: "Customer is asking for an update on order #1048.",
    context: ticketContextFor(state),
    createdAt: customerMessageAt,
    updatedAt: state === "delivered-delight" ? deliveredAt : now,
    resolvedAt: state === "delivered-delight" ? deliveredAt : null,
    manualStatusTargets: [],
    waitingOn: {
      approval: state === "merchant-approval" || state === "customer-update",
      fulfillmentOperator: state === "fulfillment-resolution",
    },
  },
  auditEntries: [],
  approvals: approvalsFor(state),
  activeReplyDelivery: null,
  approvedNotSent: null,
});

const customer = {
  id: "gid://shopify/Customer/1048",
  email: "maya@example.test",
  firstName: "Maya",
  lastName: "Chen",
  phone: "+1 503 555 0148",
  ordersCount: 4,
  totalSpent: { amount: "428.00", currencyCode: "USD" },
  defaultAddress: {
    name: "Maya Chen",
    address1: "1842 NW Everett St",
    address2: null,
    city: "Portland",
    province: "OR",
    country: "United States",
    zip: "97209",
    phone: "+1 503 555 0148",
  },
  createdAt: "2024-04-09T12:00:00.000Z",
};

const shopifyPanels = (state: DashboardDemoState) => {
  const reshipped = [
    "customer-update",
    "sent-update",
    "delivered-delight",
  ].includes(state);
  const delivered = state === "delivered-delight";
  const tracking = reshipped ? "DEMO-1Z84-2048" : "DEMO-9400-1048";
  const order = {
    id: "gid://shopify/Order/1048",
    name: "#1048",
    confirmationNumber: "DEMO1048",
    email: "maya@example.test",
    customerId: customer.id,
    fulfillmentStatus: delivered
      ? "delivered"
      : reshipped
        ? "in_transit"
        : "fulfilled",
    financialStatus: "paid",
    cancelledAt: null,
    totalPrice: { amount: "119.00", currencyCode: "USD" },
    shippingAddress: customer.defaultAddress,
    lineItems: [
      {
        id: "gid://shopify/LineItem/1048",
        title: "CloudKnit Throw",
        quantity: 1,
        sku: "CKT-SAND",
        variantTitle: "Sand",
        unitPrice: { amount: "119.00", currencyCode: "USD" },
        productId: "gid://shopify/Product/1048",
        imageUrl: null,
      },
    ],
    fulfillments: [
      {
        id: "gid://shopify/Fulfillment/1048",
        status: delivered
          ? "delivered"
          : reshipped
            ? "in_transit"
            : "fulfilled",
        trackingCompany: "UPS",
        trackingNumbers: [tracking],
        trackingUrls: [`https://example.test/track/${tracking}`],
        estimatedDeliveryAt: delivered ? null : "2026-07-21T18:00:00.000Z",
        deliveredAt: delivered ? deliveredAt : null,
        createdAt: "2026-07-09T09:00:00.000Z",
        updatedAt: delivered ? deliveredAt : now,
      },
    ],
    createdAt: "2026-07-08T15:20:00.000Z",
    updatedAt: delivered ? deliveredAt : now,
  };
  const revealCustomer =
    state !== "customer-message" && state !== "agent-investigation-empty";
  const revealOrder =
    state !== "customer-message" &&
    state !== "agent-investigation-empty" &&
    state !== "agent-investigation-customer";
  return {
    customer: revealCustomer ? customer : null,
    order: revealOrder ? order : null,
    shopDomain: "northstar-demo.myshopify.com",
    addressUpdateAfterFulfillment: false,
  };
};

const threadFor = (state: DashboardDemoState) => {
  const messages: any[] = [
    {
      id: "message-customer-question",
      direction: "inbound",
      from: { name: "Maya Chen", email: "maya@example.test" },
      to: [{ name: "Northstar Support", email: "support@northstar.example" }],
      subject: "Where is my order?",
      bodyText: "Hi, where is my order?",
      sanitizedBodyHtml: null,
      sentAt: customerMessageAt,
      attachments: [],
    },
  ];

  const reassuranceSent = new Set<DashboardDemoState>([
    "reassurance-sent",
    "fulfillment-resolution",
    "customer-update",
    "sent-update",
    "delivered-delight",
  ]).has(state);

  if (reassuranceSent) {
    messages.push({
      id: "message-reassurance",
      direction: "outbound",
      from: { name: "Northstar Support", email: "support@northstar.example" },
      to: [{ name: "Maya Chen", email: "maya@example.test" }],
      subject: "Re: Where is my order?",
      bodyText: reassurance,
      sanitizedBodyHtml: null,
      sentAt: reassuranceSentAt,
      attachments: [],
    });
  }

  if (state === "sent-update" || state === "delivered-delight") {
    messages.push({
      id: "message-reship-update",
      direction: "outbound",
      from: { name: "Northstar Support", email: "support@northstar.example" },
      to: [{ name: "Maya Chen", email: "maya@example.test" }],
      subject: "Re: Where is my order?",
      bodyText: customerUpdate,
      sanitizedBodyHtml: null,
      sentAt: now,
      attachments: [],
    });
  }

  if (state === "delivered-delight") {
    messages.push({
      id: "message-customer-happy",
      direction: "inbound",
      from: { name: "Maya Chen", email: "maya@example.test" },
      to: [{ name: "Northstar Support", email: "support@northstar.example" }],
      subject: "Re: Where is my order?",
      bodyText:
        "It arrived! I love the product, and your customer support was amazing. Thank you!",
      sanitizedBodyHtml: null,
      sentAt: deliveredAt,
      attachments: [],
    });
  }

  return {
    status: "available",
    thread: {
      subject: "Where is my order?",
      participants: [
        { name: "Maya Chen", email: "maya@example.test" },
        { name: "Northstar Support", email: "support@northstar.example" },
      ],
      messages,
    },
  };
};

const trackingFor = (state: DashboardDemoState) => {
  if (
    state === "customer-message" ||
    state === "agent-investigation-empty" ||
    state === "agent-investigation-customer" ||
    state === "agent-investigation-order"
  ) {
    return { kind: "not_found" };
  }
  const reshipped = [
    "customer-update",
    "sent-update",
    "delivered-delight",
  ].includes(state);
  const delivered = state === "delivered-delight";
  return {
    kind: "ok",
    tracking: {
      kind: "live",
      trackingNumber: reshipped ? "DEMO-1Z84-2048" : "DEMO-9400-1048",
      carrier: "UPS",
      status: delivered ? "delivered" : reshipped ? "in_transit" : "exception",
      lastScan: {
        occurredAt: delivered ? deliveredAt : "2026-07-13T08:14:00.000Z",
        location: delivered ? "Portland, OR" : "Tacoma, WA",
        description: delivered
          ? "Delivered at front door"
          : reshipped
            ? "Shipment is moving through the network"
            : "Delivery exception — no movement for 5 days",
      },
      estimatedDeliveryAt: delivered ? null : "2026-07-21T18:00:00.000Z",
      trackingUrl: "https://example.test/tracking",
      originCountry: "US",
      destinationCountry: "US",
      transitDays: delivered ? 3 : reshipped ? 1 : 10,
      checkpoints: [],
      reason: null,
    },
  };
};

const fulfillmentDetail = {
  id: "demo-escalation",
  ticketId: "demo-ticket",
  problem: escalation,
  orderRef: "#1048",
  shipCity: "Portland",
  shipCountry: "United States",
  trackingNumber: "DEMO-9400-1048",
  status: "open",
  createdAt: operatorEscalationAt,
  note: null,
  proposedResolution: null,
  requestAttachments: [],
  attachments: [],
};

const ticketRow = (state: DashboardDemoState) => ({
  id: "demo-ticket",
  subject: "Where is my order?",
  status: ticketStatusFor(state),
  scenarioKey: "order_status",
  currentAgentId: "order-status-agent",
  createdAt: customerMessageAt,
  updatedAt: state === "delivered-delight" ? deliveredAt : now,
  waitingOn: ticketDetail(state).ticket.waitingOn,
  customerEmail: "maya@example.test",
  orderRef: "#1048",
  priority: "normal",
  preview: "Customer is asking for an update on order #1048.",
});

const json = (body: any, status = 200): DemoPayload => ({ status, body });

export const dashboardDemoPayload = (
  pathWithQuery: string,
  state: DashboardDemoState,
): DemoPayload => {
  const url = new URL(pathWithQuery, "https://demo.example.test");
  const path = url.pathname;

  if (path === "/dashboard/auth/session") {
    return json({
      organizationId: "demo-organization",
      userId: "demo-manager",
      user: {
        id: "demo-manager",
        email: "manager@northstar.example",
        firstName: "Alex",
        lastName: "Morgan",
      },
    });
  }
  if (path === "/dashboard/workspaces") {
    return json({
      workspaces: [
        {
          id: "demo-merchant",
          name: "Northstar Supply",
          createdAt: "2026-01-01T00:00:00.000Z",
          shopifyDomain: "northstar-demo.myshopify.com",
          onboardingPending: false,
        },
      ],
      defaultWorkspaceId: "demo-merchant",
    });
  }
  if (path === "/dashboard/fulfillment-operator/workspaces") {
    return json({
      workspaces: [
        {
          id: "demo-partner",
          name: "Northstar Supply",
          createdAt: "2026-01-01T00:00:00.000Z",
          shopifyDomain: null,
          onboardingPending: false,
        },
      ],
      defaultWorkspaceId: "demo-partner",
    });
  }
  if (
    path === "/dashboard/me/session" ||
    path === "/dashboard/fulfillment-operator/session"
  ) {
    return json({
      isOwner: true,
      assigned: true,
      permissions: [
        "tickets.view",
        "tickets.manage",
        "approvals.view",
        "approvals.decide",
        "settings.blocked_senders",
        "fulfillment_operator.tickets.view",
        "fulfillment_operator.tickets.respond",
      ],
    });
  }
  if (path === "/dashboard/tenant") {
    return json({
      tenant: { tenantId: "demo-merchant", name: "Northstar Supply" },
    });
  }
  if (path === "/dashboard/llm") {
    return json({
      effective: { provider: "openrouter", source: "workspace" },
      workspaceOverride: null,
      accountDefault: null,
    });
  }
  if (path === "/dashboard/connections") {
    return json({
      connections: [
        {
          id: "demo-gmail",
          provider: "gmail",
          shopDomain: null,
          status: "active",
          scopes: [],
          metadata: {},
          installedAt: now,
          revokedAt: null,
          updatedAt: now,
        },
      ],
    });
  }
  if (path === "/dashboard/tickets") {
    return json({
      rows: [
        ticketRow(state),
        {
          ...ticketRow(state),
          id: "demo-ticket-2",
          subject: "Exchange request",
          customerEmail: "jamie@example.test",
          orderRef: "#1041",
          preview: "Can I exchange this for another size?",
          status: "waiting_for_customer",
        },
        {
          ...ticketRow(state),
          id: "demo-ticket-3",
          subject: "Damaged item",
          customerEmail: "ravi@example.test",
          orderRef: "#1037",
          preview: "The box arrived damaged.",
          status: "human_takeover",
        },
      ],
      page: 1,
      limit: 50,
      totalRows: 3,
      totalPages: 1,
    });
  }
  if (path === "/dashboard/tickets/demo-ticket")
    return json(ticketDetail(state));
  if (path === "/dashboard/tickets/demo-ticket/conversation-thread") {
    return json(threadFor(state));
  }
  if (path === "/dashboard/tickets/demo-ticket/shopify") {
    return json(shopifyPanels(state));
  }
  if (path === "/dashboard/tickets/demo-ticket/tracking") {
    return json(trackingFor(state));
  }
  if (path === "/dashboard/tickets/demo-ticket/events")
    return json({ events: [] });
  if (path === "/dashboard/tickets/demo-ticket/attachments") {
    return json({ attachments: [] });
  }
  if (path === "/dashboard/models") {
    return json({
      connected: true,
      provider: "openrouter",
      entries: [],
      error: null,
    });
  }
  if (path === "/dashboard/fulfillment-operator/tickets") {
    return json({ tickets: [fulfillmentDetail] });
  }
  if (path === "/dashboard/fulfillment-operator/tickets/demo-escalation") {
    return json(fulfillmentDetail);
  }

  return json({ error: `Unhandled product-demo endpoint: ${path}` }, 404);
};

export const dashboardDemoCopy = {
  reassurance,
  escalation,
  customerUpdate,
};
