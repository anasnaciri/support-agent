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
}
