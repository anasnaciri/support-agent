import { Effect, Layer } from "effect";
import { generateText, jsonSchema, type LanguageModel, type ModelMessage } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
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
  type UserContentPart,
} from "@support-agent/agent-core";
import {
  BlobStorage,
  LLMConfig,
  LLMCredentialResolver,
  LLMService,
  type LLMCredential,
  type LLMProvider,
} from "@support-agent/services";

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

const needsToolNameSanitization = (
  provider: LLMProvider,
  model: string,
): boolean =>
  provider === "anthropic" || model.startsWith("anthropic/");

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

/**
 * Translate a user-role ChatMessage's `content` (string | parts[]) into
 * the AI SDK's user-message content shape. Image parts get their bytes
 * fetched from `BlobStorage` on demand; the SDK accepts `Uint8Array` as
 * the `image` value when `mediaType` is set. Per-call cache keyed by
 * `storageKey` so the same attachment referenced twice in one request
 * isn't fetched twice.
 *
 * Errors from `BlobStorage` are mapped to `LLMError` at the boundary so
 * the runtime sees the same failure surface as a provider outage.
 */
const buildUserContent = (
  content: string | ReadonlyArray<UserContentPart>,
  blob: typeof BlobStorage.Service,
  cache: Map<string, Uint8Array>,
): Effect.Effect<string | Array<{ type: "text"; text: string } | { type: "image"; image: Uint8Array; mediaType: string }>, LLMError> => {
  if (typeof content === "string") {
    return Effect.succeed(content);
  }
  return Effect.gen(function* () {
    const out: Array<
      { type: "text"; text: string } | { type: "image"; image: Uint8Array; mediaType: string }
    > = [];
    for (const part of content) {
      if (part.type === "text") {
        out.push({ type: "text", text: part.text });
        continue;
      }
      // part.type === "image"
      const key = part.attachment.storageKey;
      const cached = cache.get(key);
      const bytes = cached
        ? cached
        : yield* blob.get(key).pipe(
            Effect.tap((r) =>
              Effect.sync(() => {
                cache.set(key, r.bytes);
              }),
            ),
            Effect.map((r) => r.bytes),
            // BlobStorage errors aren't truly LLM provider issues, but
            // the runtime only catches LLMError on the LLM boundary.
            // Surface them as NetworkError with the underlying tagged
            // error as the cause so the audit log preserves the shape.
            Effect.catchAll((e) =>
              Effect.fail(new NetworkError({ cause: e })),
            ),
          );
      out.push({
        type: "image",
        image: bytes,
        mediaType: part.attachment.contentType,
      });
    }
    return out;
  });
};

const toModelMessages = (
  messages: ReadonlyArray<ChatMessage>,
  sanitize: boolean,
  blob: typeof BlobStorage.Service,
): Effect.Effect<Array<ModelMessage>, LLMError> =>
  Effect.gen(function* () {
    const tn = (n: string): string => (sanitize ? sanitizeToolName(n) : n);
    const imageCache = new Map<string, Uint8Array>();
    const out: Array<ModelMessage> = [];
    for (const m of messages) {
      if (m.role === "user") {
        const content = yield* buildUserContent(m.content, blob, imageCache);
        out.push({ role: "user", content: content as never });
        continue;
      }
      if (m.role === "assistant") {
        const text = m.content ?? "";
        const calls = m.toolCalls ?? [];
        if (calls.length === 0) {
          out.push({ role: "assistant", content: text });
          continue;
        }
        out.push({
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
        });
        continue;
      }
      // role === "tool"
      out.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: m.toolCallId,
            toolName: tn(m.toolName),
            output: { type: "json", value: m.content as never },
          },
        ],
      });
    }
    return out;
  });

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

const mapError = (cause: unknown, providerName: LLMProvider): LLMError => {
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
      return new ProviderUnavailable({ provider: providerName });
    }
    if (msg.includes("invalid tool") || msg.includes("tool_use")) {
      return new InvalidToolCall({ tool: "unknown", issue: cause.message });
    }
    return new NetworkError({ cause });
  }
  return new NetworkError({ cause });
};

// ============================================================
// Adapter cache + factory
// ============================================================

/**
 * A "chat factory" is the function returned by an AI SDK provider that
 * yields a `LanguageModel` for a given model id. Each provider's adapter
 * has a slightly different second-argument shape (OpenRouter accepts
 * routing settings, Anthropic and OpenAI don't), so we capture the
 * provider-specific call signature here.
 */
type ChatFactory = (req: ToolCallingRequest) => LanguageModel;

const buildOpenRouterFactory = (cred: LLMCredential): ChatFactory => {
  const provider = createOpenRouter({
    apiKey: cred.apiKey,
    ...(cred.baseURL !== undefined ? { baseURL: cred.baseURL } : {}),
  });
  // OpenRouter routes requests for Anthropic models across multiple
  // backends (Anthropic native, Amazon Bedrock, Google Vertex). Bedrock
  // enforces a stricter tool-name regex (`^[a-zA-Z0-9_-]{1,128}$`) that
  // rejects the dots in our tool names. Pin Anthropic models to the
  // native Anthropic endpoint so the tool schema is accepted. Other
  // providers (google/*, openai/*, etc.) use OpenRouter's default routing.
  return (req) =>
    req.model.startsWith("anthropic/")
      ? provider.chat(req.model, {
          provider: {
            only: ["anthropic"],
            allow_fallbacks: false,
          },
        })
      : provider.chat(req.model);
};

const buildAnthropicFactory = (cred: LLMCredential): ChatFactory => {
  const provider = createAnthropic({
    apiKey: cred.apiKey,
    ...(cred.baseURL !== undefined ? { baseURL: cred.baseURL } : {}),
  });
  return (req) => provider(req.model);
};

const buildOpenAIFactory = (cred: LLMCredential): ChatFactory => {
  const provider = createOpenAI({
    apiKey: cred.apiKey,
    ...(cred.baseURL !== undefined ? { baseURL: cred.baseURL } : {}),
  });
  return (req) => provider(req.model);
};

const buildFactory = (cred: LLMCredential): ChatFactory => {
  switch (cred.provider) {
    case "openrouter":
      return buildOpenRouterFactory(cred);
    case "anthropic":
      return buildAnthropicFactory(cred);
    case "openai":
      return buildOpenAIFactory(cred);
  }
};

const cacheKey = (cred: LLMCredential): string =>
  `${cred.provider}\x00${cred.apiKey}\x00${cred.baseURL ?? ""}`;

// ============================================================
// Live Layer
// ============================================================

/**
 * Live LLMService backed by the Vercel AI SDK. BYOK: every call resolves
 * the tenant's per-provider credential via `LLMCredentialResolver`, builds
 * (or reuses) the matching AI SDK adapter, and dispatches `generateText`
 * in single-step mode. We drive the tool-call/result loop ourselves in
 * `AgentRuntime`, so the SDK does one model call per invocation.
 *
 * The adapter cache is keyed by `(provider, apiKey, baseURL)` — one entry
 * per active tenant in steady state. Cache stays in the Layer's closure
 * for the lifetime of the worker; rotating a key writes a new cache entry
 * on the next call and the old one becomes orphan (acceptable: APIs reject
 * a rotated key, and the orphan entry is small).
 */
export const LLMServiceLive = Layer.effect(
  LLMService,
  Effect.gen(function* () {
    const resolver = yield* LLMCredentialResolver;
    const blob = yield* BlobStorage;
    const cache = new Map<string, ChatFactory>();

    const factoryFor = (cred: LLMCredential): ChatFactory => {
      const key = cacheKey(cred);
      const existing = cache.get(key);
      if (existing) return existing;
      const built = buildFactory(cred);
      cache.set(key, built);
      return built;
    };

    return LLMService.of({
      runToolCalling: (req: ToolCallingRequest) =>
        Effect.gen(function* () {
          const cred = yield* resolver.resolve(req.tenantId).pipe(
            // The resolver can fail with a DB error (Postgres unreachable,
            // for instance). LLMService.runToolCalling's error union is
            // `LLMError`, so map the DB error to NetworkError — same way an
            // OpenRouter outage would surface.
            Effect.catchTag("ConnectorStoreDbError", (e) =>
              Effect.fail(new NetworkError({ cause: e.cause })),
            ),
          );
          const sanitize = needsToolNameSanitization(cred.provider, req.model);
          const reverseMap = sanitize
            ? buildReverseToolNameMap(req.tools)
            : new Map<string, string>();
          const factory = factoryFor(cred);
          const modelMessages = yield* toModelMessages(
            req.messages,
            sanitize,
            blob,
          );
          const result = yield* Effect.tryPromise({
            try: () =>
              generateText({
                model: factory(req),
                system: req.system,
                messages: modelMessages,
                tools: toToolSet(req.tools, sanitize),
                ...(req.temperature !== undefined
                  ? { temperature: req.temperature }
                  : {}),
                ...(req.maxTokens !== undefined
                  ? { maxOutputTokens: req.maxTokens }
                  : {}),
              }),
            catch: (cause) => mapError(cause, cred.provider),
          });
          // Capture token usage from the AI SDK when present so the
          // runtime can stamp it into the `llm.decision` audit row.
          // Providers differ in which usage fields they populate; we
          // accept either the new (`inputTokens`/`outputTokens`) or the
          // older (`promptTokens`/`completionTokens`) shape. When the
          // SDK didn't report usage at all we OMIT the field — keeps
          // the decision shape backwards-compatible with tests that
          // mock `generateText` without a `usage` block.
          const rawUsage = (result as { usage?: unknown }).usage;
          const u =
            rawUsage && typeof rawUsage === "object"
              ? (rawUsage as Record<string, unknown>)
              : null;
          const numOrNull = (v: unknown): number | null =>
            typeof v === "number" && Number.isFinite(v) ? v : null;
          const usage = u
            ? {
                model: req.model,
                provider: cred.provider,
                inputTokens:
                  numOrNull(u["inputTokens"]) ??
                  numOrNull(u["promptTokens"]),
                outputTokens:
                  numOrNull(u["outputTokens"]) ??
                  numOrNull(u["completionTokens"]),
              }
            : null;
          const call = result.toolCalls[0];
          if (call) {
            return {
              type: "tool_call",
              callId: call.toolCallId,
              tool: sanitize
                ? desanitize(call.toolName, reverseMap)
                : call.toolName,
              input: call.input,
              ...(usage ? { usage } : {}),
            } satisfies LLMDecision;
          }
          return {
            type: "final_message",
            text: result.text,
            ...(usage ? { usage } : {}),
          } satisfies LLMDecision;
        }),
    });
  }),
);

// ============================================================
// Dev-only: LLMConfig → single-tenant LLMCredentialResolver adapter
// ============================================================
//
// Pre-BYOK, `LLMServiceLive` depended directly on `LLMConfig` and the worker
// bootstrap supplied an `OPENROUTER_API_KEY` from process.env. After BYOK
// the production path resolves credentials per tenant via the
// `LLMCredentialResolver` consulted by `LLMServiceLive`. This factory keeps
// single-tenant dev workflows working: provide it with an `LLMConfig` and
// it builds a resolver that returns the same OpenRouter credential for
// every tenantId. **Do not wire this in production** — tenants must bring
// their own keys (master-plan §20).

export const LLMConfigFromEnv = Layer.effect(
  LLMConfig,
  Effect.sync(() => {
    const apiKey = process.env["OPENROUTER_API_KEY"];
    if (!apiKey) {
      throw new Error(
        "OPENROUTER_API_KEY is not set — required to build LLMConfigFromEnv (dev only)",
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

/**
 * Dev-only adapter: read `LLMConfig` and serve the same OpenRouter
 * credential for any tenant. Use only for single-tenant dev. Production
 * worker bootstrap should provide `LLMCredentialResolverLive` over
 * `ConnectorCredentialStoreLive` instead.
 */
export const LLMCredentialResolverFromLLMConfig = Layer.effect(
  LLMCredentialResolver,
  Effect.gen(function* () {
    const cfg = yield* LLMConfig;
    return LLMCredentialResolver.of({
      resolve: () =>
        Effect.succeed({
          provider: "openrouter" as const,
          apiKey: cfg.apiKey,
          ...(cfg.baseURL !== undefined ? { baseURL: cfg.baseURL } : {}),
        }),
    });
  }),
);
