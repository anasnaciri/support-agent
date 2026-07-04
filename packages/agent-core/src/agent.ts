import type { AgentId } from "./ids.js";

export type ProviderName =
  | "openai"
  | "anthropic"
  | "gemini"
  | "openrouter"
  | "local";

export type Permission = "allow" | "ask" | "deny";

export type AgentMode = "primary" | "subagent";

export interface AgentConfig {
  readonly id: AgentId;
  readonly name: string;
  readonly description: string;
  readonly mode: AgentMode;
  readonly provider: ProviderName;
  readonly model: string;
  readonly fallback?: { readonly provider: ProviderName; readonly model: string };
  readonly promptTemplate: string;
  readonly tools: ReadonlyArray<string>;
  readonly permissionOverrides: Readonly<Record<string, Permission>>;
  readonly handoffs: ReadonlyArray<AgentId>;
  readonly maxTurnsPerTick: number;
  readonly temperature?: number;
  /**
   * Opt-in to the autonomous resolution loop (master-plan: scenario agent).
   *
   * `false`/absent (every legacy agent) → the terminal loop: a gated (`ask`)
   * tool parks the ticket in `waiting_for_approval` and ends the tick; the agent
   * stops the moment the harness decides a tool is terminal.
   *
   * `true` → tools are non-blocking. A gated (`ask`) action is QUEUED (a pending
   * approval row) and the loop CONTINUES; the agent itself decides when to stop
   * by emitting a final answer. At end-of-loop the runtime maps the accumulated
   * state to a status: queued actions → one `waiting_for_approval` bundle; an
   * auto reply sent → `resolved`; nothing actionable → `human_takeover`.
   *
   * Enforcement guards (spending caps, the unverified-mismatch disclosure
   * backstop) still apply on top — this flag widens cognition, never the walls.
   */
  readonly autonomousLoop?: boolean;
}
