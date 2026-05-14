import { Context, Effect, Layer, Ref } from "effect";
import type {
  LLMDecision,
  LLMError,
  ToolCallingRequest,
} from "@support-agent/agent-core";

// ============================================================
// Tag
// ============================================================

/**
 * The Vercel AI SDK adapter lands in Phase 2 as the Live layer; for now we
 * ship the Tag plus deterministic Test layers so the runtime tick can be
 * developed and tested without an API key or a network call.
 *
 * Phase 1 only needs `runToolCalling`. `generateText` and `generateStructured`
 * (master-plan §6) will be added when a non-tool-calling use case appears.
 */
export class LLMService extends Context.Tag("LLMService")<
  LLMService,
  {
    readonly runToolCalling: (
      req: ToolCallingRequest,
    ) => Effect.Effect<LLMDecision, LLMError>;
  }
>() {}

// ============================================================
// Scripted Test layer — pops one decision per call
// ============================================================

/**
 * Build a Test layer that yields a fixed sequence of decisions, one per
 * call to `runToolCalling`. If the script is exhausted the effect dies
 * (Effect.die) — that signals a test bug, not a recoverable LLM error.
 */
export const LLMServiceScripted = (
  decisions: ReadonlyArray<LLMDecision>,
) =>
  Layer.effect(
    LLMService,
    Effect.gen(function* () {
      const ref = yield* Ref.make(0);
      return LLMService.of({
        runToolCalling: () =>
          Effect.gen(function* () {
            const i = yield* Ref.getAndUpdate(ref, (n) => n + 1);
            const d = decisions[i];
            if (!d) {
              return yield* Effect.dieMessage(
                `LLMServiceScripted: ran out of decisions at call ${i + 1}, only ${decisions.length} were provided`,
              );
            }
            return d;
          }),
      });
    }),
  );

// ============================================================
// Function-backed Test layer — full programmability
// ============================================================

export interface ScriptedFnContext {
  readonly callIndex: number;
}

/**
 * Build a Test layer whose decision is computed by a function of the
 * incoming request and the call index. Use when you need branching test
 * behavior the scripted variant can't express.
 */
export const LLMServiceFromFn = (
  fn: (
    req: ToolCallingRequest,
    ctx: ScriptedFnContext,
  ) => Effect.Effect<LLMDecision, LLMError>,
) =>
  Layer.effect(
    LLMService,
    Effect.gen(function* () {
      const ref = yield* Ref.make(0);
      return LLMService.of({
        runToolCalling: (req) =>
          Effect.gen(function* () {
            const callIndex = yield* Ref.getAndUpdate(ref, (n) => n + 1);
            return yield* fn(req, { callIndex });
          }),
      });
    }),
  );
