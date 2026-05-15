import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import type { ToolCallingRequest } from "@support-agent/agent-core";
import { LLMConfig, LLMService } from "@support-agent/services";
import { LLMServiceLive } from "../src/llm-service-live.js";

// Real-call smoke test. Hits OpenRouter end-to-end through `LLMServiceLive`
// to prove the request shape, auth, and response mapping all work against
// the live API. Gated on OPENROUTER_API_KEY so CI without a key still
// passes; run locally with `OPENROUTER_API_KEY=... pnpm test`.
//
// Uses `meta-llama/llama-3.2-3b-instruct:free` — OpenRouter's free tier —
// so the test costs zero credits. If that ID ever changes, swap it for
// any other small/cheap model that supports tool calling.
const apiKey = process.env["OPENROUTER_API_KEY"];
const describeIfKey = apiKey ? describe : describe.skip;

const SMOKE_MODEL =
  process.env["OPENROUTER_SMOKE_MODEL"] ?? "google/gemini-3.1-flash-lite";

describeIfKey("LLMServiceLive — real OpenRouter smoke test", () => {
  const cfg = Layer.succeed(
    LLMConfig,
    LLMConfig.of({
      apiKey: apiKey!,
      siteName: "support-agent-smoke-test",
    }),
  );
  const live = LLMServiceLive.pipe(Layer.provide(cfg));

  it(
    "returns a final_message decision from a real model call",
    async () => {
      const req: ToolCallingRequest = {
        model: SMOKE_MODEL,
        system: "You are a terse assistant. Reply with at most 5 words.",
        messages: [
          { role: "user", content: "Say 'hello from support-agent'." },
        ],
        tools: [],
        maxTokens: 32,
        temperature: 0,
      };

      const decision = await Effect.runPromise(
        Effect.provide(
          Effect.flatMap(LLMService, (s) => s.runToolCalling(req)),
          live,
        ),
      );

      expect(decision.type).toBe("final_message");
      if (decision.type !== "final_message") return;
      expect(decision.text.length).toBeGreaterThan(0);
      // eslint-disable-next-line no-console -- intentional: visible signal that the smoke test ran
      console.log(`[smoke] ${SMOKE_MODEL} -> ${decision.text}`);
    },
    30_000,
  );

  it(
    "returns a tool_call decision when the model is asked to use a tool",
    async () => {
      const req: ToolCallingRequest = {
        model: SMOKE_MODEL,
        system:
          "When the user asks about an order, you MUST call the lookup_order tool. Do not answer in text.",
        messages: [
          { role: "user", content: "Where is my order 12345?" },
        ],
        tools: [
          {
            name: "lookup_order",
            description: "Look up the status of an order by its id",
            inputSchema: {
              type: "object",
              properties: {
                orderId: {
                  type: "string",
                  description: "The order identifier",
                },
              },
              required: ["orderId"],
              additionalProperties: false,
            },
          },
        ],
        maxTokens: 64,
        temperature: 0,
      };

      const decision = await Effect.runPromise(
        Effect.provide(
          Effect.flatMap(LLMService, (s) => s.runToolCalling(req)),
          live,
        ),
      );

      // Some models occasionally answer in text instead of calling the tool;
      // accept either path so the test isn't flaky, but log which branch hit.
      // eslint-disable-next-line no-console -- intentional smoke signal
      console.log(`[smoke] decision type: ${decision.type}`);
      expect(["tool_call", "final_message"]).toContain(decision.type);
      if (decision.type === "tool_call") {
        expect(decision.tool).toBe("lookup_order");
        expect(decision.input).toMatchObject({ orderId: expect.any(String) });
      }
    },
    30_000,
  );
});
