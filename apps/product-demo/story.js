export const DEMO_DATA = {
  merchant: {
    name: "Northstar Supply",
  },
  customer: {
    name: "Maya Chen",
    email: "maya@example.test",
    message: "Hi, where is my order?",
    happyReply:
      "It arrived! I love the product, and your support was amazing. Thank you!",
  },
  order: {
    reference: "#1048",
    product: "CloudKnit Throw",
    placedAt: "July 8, 2026",
    initialTracking: {
      number: "DEMO-9400-1048",
      status: "Undelivered",
    },
    reshipmentTracking: {
      number: "DEMO-1Z84-2048",
      status: "In transit",
    },
    finalStatus: "Delivered",
  },
  drafts: {
    reassurance:
      "I'm sorry about the delay. I'm checking this with our fulfillment partner now and will update you as soon as I have new tracking information.",
    escalation:
      "Order #1048 appears undelivered. Please confirm its status and reship if necessary.",
    partnerUpdate: "Item reshipped.",
    customerUpdate:
      "Good news—your order has been reshipped. Your new tracking number is DEMO-1Z84-2048. We'll keep an eye on it until it arrives.",
  },
};

export const SUPPORT_DEMO_STORY = {
  duration: 45,
  scenes: [
    { id: "customer-message", start: 0, end: 6 },
    { id: "agent-investigation", start: 6, end: 13 },
    { id: "merchant-approval", start: 13, end: 18 },
    { id: "fulfillment-resolution", start: 18, end: 28 },
    { id: "customer-update", start: 28, end: 37 },
    { id: "delivered-delight", start: 37, end: 45 },
  ],
};

export const sceneAt = (seconds) => {
  const scene = SUPPORT_DEMO_STORY.scenes.find(
    (candidate) => seconds >= candidate.start && seconds < candidate.end,
  );

  if (!scene) {
    throw new RangeError(
      `Story time must be between 0 and ${SUPPORT_DEMO_STORY.duration}.`,
    );
  }

  return scene;
};
