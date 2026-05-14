import type { Tool } from "./tool.js";

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
export const defineTool = <I, O>(tool: Tool<I, O>): Tool<I, O> => tool;
