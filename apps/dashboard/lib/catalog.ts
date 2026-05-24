import "server-only";
import type { AgentConfig, Tool, Permission } from "@support-agent/agent-core";
import {
  missingPackageAgent,
  orderStatusAgent,
  refundReviewAgent,
  supportTriage,
} from "@support-agent/agents";
import {
  agentHandoff,
  caseUpdateContext,
  caseUpdateStatus,
  conversationAskCustomer,
  conversationFetchThread,
  conversationReply,
  shopifyGetCustomer,
  shopifyGetOrder,
  shopifyRefundCreate,
} from "@support-agent/tools";

// Read-only inventory of every AgentConfig + Tool registered in the
// platform. Settings pages render from this in-memory snapshot — the
// same configs the worker bootstrap registers, sourced from the same
// modules. When a new agent or tool ships, add it here once and the
// settings pages pick it up.
//
// Edit flows (change a prompt, flip a permission) are intentionally
// deferred: today the configs live in code, so the dashboard is a
// viewer. Once we move configs into DB rows (or a Plugin SDK install
// surface), the writers will land alongside that work.

export const agents: ReadonlyArray<AgentConfig> = [
  supportTriage,
  orderStatusAgent,
  refundReviewAgent,
  missingPackageAgent,
];

export const tools: ReadonlyArray<Tool<unknown, unknown>> = [
  caseUpdateContext,
  caseUpdateStatus,
  agentHandoff,
  conversationFetchThread,
  conversationReply,
  conversationAskCustomer,
  shopifyGetOrder,
  shopifyGetCustomer,
  shopifyRefundCreate,
] as ReadonlyArray<Tool<unknown, unknown>>;

export const findAgent = (id: string): AgentConfig | null =>
  agents.find((a) => a.id === id) ?? null;

export const findTool = (name: string): Tool<unknown, unknown> | null =>
  tools.find((t) => t.name === name) ?? null;

export const effectivePermission = (
  agent: AgentConfig,
  toolName: string,
): Permission | null => {
  const tool = findTool(toolName);
  if (!tool) return null;
  return agent.permissionOverrides[toolName] ?? tool.defaultPermission;
};
