import type { Tool } from "./tool.js";
import { toolDisplayName } from "./tool-display-names.js";

/**
 * What a tool file writes: everything on {@link Tool} except that
 * `displayName` may be omitted — `defineTool` fills it from
 * `TOOL_DISPLAY_NAMES` (tool-display-names.ts, THE naming source of truth)
 * so every tool ends up with a merchant-readable name without each file
 * carrying copy that then drifts. Inline `displayName` still wins when set
 * (test fixtures); the real tools rely on the map.
 */
export type ToolDefinition<I, O> = Omit<Tool<I, O>, "displayName"> & {
  readonly displayName?: string;
};

/**
 * Typed-identity helper for declaring a Tool. Use this at the top of every
 * tool file so the TypeScript checker captures the precise `I`/`O` for you
 * and you get autocomplete in `execute`.
 *
 * @example
 * export const shopifyGetOrder = defineTool({
 *   name: "shopify.get_order",
 *   description: "...",
 *   inputSchema: Schema.Struct({ orderNumber: Schema.String }),
 *   outputSchema: OrderResult,
 *   risk: "read",
 *   defaultPermission: "allow",
 *   sideEffectClass: "none",
 *   execute: (input, ctx) => Effect.gen(function*() { ... }),
 * })
 */
export const defineTool = <I, O>(tool: ToolDefinition<I, O>): Tool<I, O> => ({
  ...tool,
  displayName: tool.displayName ?? toolDisplayName(tool.name),
});
