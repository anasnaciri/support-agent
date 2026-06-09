import type { AgentConfig } from "@support-agent/agent-core";
import { supportTriage } from "./support-triage.js";
import { orderStatusAgent } from "./order-status-agent.js";
import { refundReviewAgent } from "./refund-review-agent.js";
import { missingPackageAgent } from "./missing-package-agent.js";
import { damagedProductAgent } from "./damaged-product-agent.js";
import { generalInquiryAgent } from "./general-inquiry-agent.js";

export * from "./support-triage.js";
export * from "./order-status-agent.js";
export * from "./refund-review-agent.js";
export * from "./missing-package-agent.js";
export * from "./damaged-product-agent.js";
export * from "./general-inquiry-agent.js";

/**
 * Canonical list of every agent the platform ships with. Every consumer
 * (worker runtime registry, dashboard settings catalog, tests that need
 * the full set) imports this constant instead of hand-listing the
 * agents. Adding a new agent means adding it here exactly once — the
 * runtime + dashboard pick it up automatically.
 *
 * Order is intentional: `supportTriage` first (the primary agent), then
 * specialists in the order triage routes to them. Dashboards render in
 * this order too.
 */
export const ALL_AGENTS: ReadonlyArray<AgentConfig> = [
  supportTriage,
  orderStatusAgent,
  refundReviewAgent,
  missingPackageAgent,
  damagedProductAgent,
  generalInquiryAgent,
];
