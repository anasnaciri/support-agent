/**
 * One-shot CLI smoke test for LLMServiceLive against OpenRouter.
 *
 * Usage (from repo root):
 *   set -a; source .env.local; set +a
 *   pnpm llm:smoke
 *
 * Or one-shot:
 *   OPENROUTER_API_KEY=... pnpm llm:smoke
 *
 * Optional env:
 *   OPENROUTER_SMOKE_MODEL   model id (default: openai/gpt-4o-mini)
 *   OPENROUTER_SMOKE_PROMPT  override the user prompt
 */

import { Effect, Layer } from "effect";
import { LLMConfig, LLMService } from "@support-agent/services";
import { LLMServiceLive } from "../src/llm-service-live.js";

const apiKey = process.env["OPENROUTER_API_KEY"];
if (!apiKey) {
  console.error("OPENROUTER_API_KEY is required");
  process.exit(1);
}

const model = process.env["OPENROUTER_SMOKE_MODEL"] ?? "google/gemini-3.1-flash-lite";
const userPrompt =
  process.env["OPENROUTER_SMOKE_PROMPT"] ??
  "Say 'hello from support-agent' and nothing else.";

const cfg = Layer.succeed(
  LLMConfig,
  LLMConfig.of({ apiKey, siteName: "support-agent-cli-smoke" }),
);
const live = LLMServiceLive.pipe(Layer.provide(cfg));

console.log(`[smoke] model=${model}`);
console.log(`[smoke] prompt=${userPrompt}`);

const program = Effect.gen(function* () {
  const llm = yield* LLMService;
  return yield* llm.runToolCalling({
    model,
    system: "You are a terse assistant.",
    messages: [{ role: "user", content: userPrompt }],
    tools: [],
    maxTokens: 64,
    temperature: 0,
  });
});

try {
  const decision = await Effect.runPromise(Effect.provide(program, live));
  console.log("[smoke] decision:", JSON.stringify(decision, null, 2));
} catch (err) {
  console.error("[smoke] failed:", err);
  process.exit(1);
}
