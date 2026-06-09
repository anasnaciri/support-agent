import type { AgentDto } from "@support-agent/dashboard-contracts";

// Pure view logic for the agent-name dropdown on the agent detail page.
// Kept apart from the client component so it can be unit-tested without a DOM.

/** The detail route for an agent, by id. */
export const agentHref = (id: string): string => `/settings/agents/${id}`;

/** One row in the agent switcher dropdown. */
export interface AgentSwitcherOption {
  readonly id: string;
  readonly name: string;
  readonly mode: AgentDto["mode"];
  readonly href: string;
  /** True for the agent currently being viewed. */
  readonly current: boolean;
}

/**
 * Build the switcher rows from the catalog, in catalog order, flagging the
 * agent currently being viewed. `currentId` not matching any agent simply
 * flags nothing.
 */
export const agentSwitcherOptions = (
  agents: ReadonlyArray<Pick<AgentDto, "id" | "name" | "mode">>,
  currentId: string,
): ReadonlyArray<AgentSwitcherOption> =>
  agents.map((a) => ({
    id: a.id,
    name: a.name,
    mode: a.mode,
    href: agentHref(a.id),
    current: a.id === currentId,
  }));
