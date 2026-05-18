import { Effect, Layer } from "effect";
import { generateText, jsonSchema, type ModelMessage } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  ContextTooLarge,
  InvalidToolCall,
  NetworkError,
  ProviderUnavailable,
  SafetyBlocked,
  type ChatMessage,
  type LLMDecision,
  type LLMError,
  type ToolCallingRequest,
  type ToolSchema,
} from "@support-agent/agent-core";
import { LLMConfig, LLMService } from "@support-agent/services";

// ============================================================
// Anthropic tool-name sanitization
// ============================================================
//
// Anthropic's API enforces a tool-name regex `^[a-zA-Z0-9_-]{1,128}$` —
// dots are rejected. Our tool names use dotted namespacing
// (`case.update_context`, `shopify.get_order`, etc.) which works on every
// other provider. To support Anthropic without renaming every tool
// globally, we sanitize dots → underscores at the LLM provider boundary
// (on tool schemas going out + tool-call references in conversation
// history) and reverse-map on the way back. Internal API everywhere else
// — `AgentRuntime`, `ToolRegistry`, audit log, prompts — keeps the dotted
// names unchanged.

const needsToolNameSanitization = (model: string): boolean =>
  model.startsWith("anthropic/");

const sanitizeToolName = (name: string): string => name.replace(/\./g, "_");

const buildReverseToolNameMap = (
  tools: ReadonlyArray<ToolSchema>,
): Map<string, string> => {
  const m = new Map<string, string>();
  for (const t of tools) m.set(sanitizeToolName(t.name), t.name);
  return m;
};

const desanitize = (
  name: string,
  reverseMap: ReadonlyMap<string, string>,
): string => reverseMap.get(name) ?? name;

// ============================================================
// Internal: ChatMessage → AI SDK ModelMessage
// ============================================================

const toModelMessages = (
  messages: ReadonlyArray<ChatMessage>,
  sanitize: boolean,
): Array<ModelMessage> => {
  const tn = (n: string): string => (sanitize ? sanitizeToolName(n) : n);
  return messages.map((m): ModelMessage => {
    if (m.role === "user") {
      return { role: "user", content: m.content };
    }
    if (m.role === "assistant") {
      const text = m.content ?? "";
      const calls = m.toolCalls ?? [];
      if (calls.length === 0) {
        return { role: "assistant", content: text };
      }
      return {
        role: "assistant",
        content: [
          ...(text.length > 0
            ? ([{ type: "text" as const, text }] as const)
            : []),
          ...calls.map((c) => ({
            type: "tool-call" as const,
            toolCallId: c.id,
            toolName: tn(c.name),
            input: c.input,
          })),
        ],
      };
    }
    // role === "tool"
    return {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: m.toolCallId,
          toolName: tn(m.toolName),
          output: { type: "json", value: m.content as never },
        },
      ],
    };
  });
};

// ============================================================
// Internal: ToolSchema[] → AI SDK ToolSet
// ============================================================

const toToolSet = (
  tools: ReadonlyArray<ToolSchema>,
  sanitize: boolean,
) =>
  Object.fromEntries(
    tools.map((t) => [
      sanitize ? sanitizeToolName(t.name) : t.name,
      {
        description: t.description,
        // The schemas we receive are already JSON Schema (derived from Effect
        // Schemas by ToolRegistry.schemasFor). Wrap them with the SDK's
        // jsonSchema helper so the SDK doesn't try to introspect them as Zod.
        inputSchema: jsonSchema(t.inputSchema as never),
      },
    ]),
  );

// ============================================================
// Internal: errors → LLMError
// ============================================================

const mapError = (cause: unknown): LLMError => {
  // Diagnostic: emit the raw error so the underlying message isn't lost
  // when we wrap it in a tagged error whose toString is generic. Cheap +
  // single line; leave on for now — we will swap this for a proper
  // structured logger when OTel logging lands.
  // eslint-disable-next-line no-console
  console.error(
    "[LLMServiceLive] underlying error:",
    cause instanceof Error
      ? `${cause.name}: ${cause.message}` +
          ((cause as { statusCode?: number }).statusCode
            ? ` (status ${(cause as { statusCode?: number }).statusCode})`
            : "")
      : cause,
  );
  if (cause instanceof Error) {
    const msg = cause.message.toLowerCase();
    const status = (cause as { statusCode?: number }).statusCode;
    if (
      msg.includes("context length") ||
      msg.includes("context_length") ||
      msg.includes("maximum context")
    ) {
      // OpenRouter doesn't always report tokens; surface 0/0 if unknown.
      return new ContextTooLarge({ tokens: 0, limit: 0 });
    }
    if (
      msg.includes("safety") ||
      msg.includes("content policy") ||
      msg.includes("blocked by")
    ) {
      return new SafetyBlocked({ reason: cause.message });
    }
    if (status === 429 || (status !== undefined && status >= 500)) {
      return new ProviderUnavailable({ provider: "openrouter" });
    }
    if (msg.includes("invalid tool") || msg.includes("tool_use")) {
      return new InvalidToolCall({ tool: "unknown", issue: cause.message });
    }
    return new NetworkError({ cause });
  }
  return new NetworkError({ cause });
};

// ============================================================
// Live Layer
// ============================================================

/**
 * Live LLMService backed by the Vercel AI SDK + OpenRouter.
 *
 * Depends on `LLMConfig`. Each `runToolCalling` call maps the
 * `ToolCallingRequest` onto `generateText` in single-step mode (we drive
 * the tool-call/result loop ourselves in `AgentRuntime`, so the SDK does
 * one model call per invocation and we read the first decision out).
 */
export const LLMServiceLive = Layer.effect(
  LLMService,
  Effect.gen(function* () {
    const cfg = yield* LLMConfig;

    const provider = createOpenRouter({
      apiKey: cfg.apiKey,
      ...(cfg.baseURL !== undefined ? { baseURL: cfg.baseURL } : {}),
      ...(cfg.siteUrl !== undefined ? { appUrl: cfg.siteUrl } : {}),
      ...(cfg.siteName !== undefined ? { appName: cfg.siteName } : {}),
    });

    // OpenRouter routes requests for Anthropic models across multiple
    // backends (Anthropic native, Amazon Bedrock, Google Vertex). Bedrock
    // enforces a stricter tool-name regex (`^[a-zA-Z0-9_-]{1,128}$`) that
    // rejects the dots in our tool names (`case.update_context` etc).
    // Pin Anthropic models to the native Anthropic endpoint so the tool
    // schema is accepted. Other providers (google/*, openai/*, etc.) use
    // OpenRouter's default routing.
    const chatSettingsFor = (model: string) =>
      model.startsWith("anthropic/")
        ? {
            provider: {
              only: ["anthropic"],
              allow_fallbacks: false,
            },
          }
        : {};

    return LLMService.of({
      runToolCalling: (req: ToolCallingRequest) => {
        const sanitize = needsToolNameSanitization(req.model);
        const reverseMap = sanitize
          ? buildReverseToolNameMap(req.tools)
          : new Map<string, string>();
        return Effect.tryPromise({
          try: () =>
            generateText({
              model: provider.chat(req.model, chatSettingsFor(req.model)),
              system: req.system,
              messages: toModelMessages(req.messages, sanitize),
              tools: toToolSet(req.tools, sanitize),
              ...(req.temperature !== undefined
                ? { temperature: req.temperature }
                : {}),
              ...(req.maxTokens !== undefined
                ? { maxOutputTokens: req.maxTokens }
                : {}),
            }),
          catch: (cause) => mapError(cause),
        }).pipe(
          Effect.flatMap((result): Effect.Effect<LLMDecision, LLMError> => {
            const call = result.toolCalls[0];
            if (call) {
              return Effect.succeed({
                type: "tool_call",
                callId: call.toolCallId,
                tool: sanitize
                  ? desanitize(call.toolName, reverseMap)
                  : call.toolName,
                input: call.input,
              });
            }
            return Effect.succeed({
              type: "final_message",
              text: result.text,
            });
          }),
        );
      },
    });
  }),
);

// ============================================================
// LLMConfig from process.env
// ============================================================

/**
 * Reads OpenRouter credentials from `process.env`. Fails the Layer build
 * if `OPENROUTER_API_KEY` is missing — the worker should crash on startup
 * rather than discover it at first-LLM-call.
 */
export const LLMConfigFromEnv = Layer.effect(
  LLMConfig,
  Effect.sync(() => {
    const apiKey = process.env["OPENROUTER_API_KEY"];
    if (!apiKey) {
      throw new Error(
        "OPENROUTER_API_KEY is not set — required to build LLMServiceLive",
      );
    }
    const baseURL = process.env["OPENROUTER_BASE_URL"];
    const siteUrl = process.env["OPENROUTER_SITE_URL"];
    const siteName = process.env["OPENROUTER_SITE_NAME"];
    return LLMConfig.of({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
      ...(siteUrl ? { siteUrl } : {}),
      ...(siteName ? { siteName } : {}),
    });
  }),
);
