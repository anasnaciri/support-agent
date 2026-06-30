import { Effect, Layer } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContextTooLarge,
  InsufficientCredits,
  NetworkError,
  ProviderUnavailable,
  SafetyBlocked,
  TenantId,
  type ChatMessage,
  type ToolCallingRequest,
} from "@support-agent/agent-core";
import {
  BlobStorageTest,
  LLMCredentialResolverTest,
  LLMService,
  type LLMCredential,
} from "@support-agent/services";

const testTenantId = TenantId("00000000-0000-0000-0000-000000000001");

// ---------- Module mock ------------------------------------------------------
// Vitest hoists vi.mock above imports, so the `generateText` we import inside
// each test reaches into the mocked module's exported spy. We keep `jsonSchema`
// as a pass-through (returning whatever JSON Schema was passed) so we can
// inspect tool wiring in assertions.

const generateText = vi.fn();
const jsonSchemaSpy = vi.fn((s: unknown) => ({ __wrapped: s }));

vi.mock("ai", () => ({
  generateText: (...args: ReadonlyArray<unknown>) =>
    generateText(...args) as unknown,
  jsonSchema: (s: unknown) => jsonSchemaSpy(s),
}));

vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: (opts: unknown) => {
    const provider = (modelId: string) => ({ __chat: modelId });
    (provider as unknown as { chat: unknown }).chat = (
      modelId: string,
      settings?: unknown,
    ) => ({
      __chat: modelId,
      __providerOpts: opts,
      __chatSettings: settings,
      __providerKind: "openrouter",
    });
    return provider;
  },
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: (opts: unknown) => {
    const provider = (modelId: string) => ({
      __chat: modelId,
      __providerOpts: opts,
      __providerKind: "anthropic",
    });
    return provider;
  },
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: (opts: unknown) => {
    const provider = (modelId: string) => ({
      __chat: modelId,
      __providerOpts: opts,
      __providerKind: "openai",
    });
    return provider;
  },
}));

// Defer importing the live layer until after the mocks are registered.
const { LLMServiceLive } = await import("../src/llm-service-live.js");

// ---------- Helpers ----------------------------------------------------------

const defaultCred: LLMCredential = {
  provider: "openrouter",
  apiKey: "test-key",
};

const resolverLayer = LLMCredentialResolverTest(
  new Map([[testTenantId, defaultCred]]),
);
const blobLayerEmpty = BlobStorageTest({});

const runWith = <A, E>(
  eff: Effect.Effect<A, E, LLMService>,
  blobLayer: ReturnType<typeof BlobStorageTest> = blobLayerEmpty,
) =>
  Effect.runPromiseExit(
    Effect.provide(
      eff,
      LLMServiceLive.pipe(Layer.provide(Layer.merge(resolverLayer, blobLayer))),
    ),
  );

const baseRequest: ToolCallingRequest = {
  tenantId: testTenantId,
  model: "google/gemini-3.1-flash-lite",
  system: "you are a test",
  messages: [
    { role: "user", content: "where is my order?" } satisfies ChatMessage,
  ],
  tools: [
    {
      name: "case.update_status",
      description: "transition the case",
      inputSchema: { type: "object", properties: { to: { type: "string" } } },
    },
  ],
};

beforeEach(() => {
  generateText.mockReset();
  jsonSchemaSpy.mockClear();
});

// ---------- Tests ------------------------------------------------------------

describe("LLMServiceLive — request mapping", () => {
  it("maps ChatMessage[] → ModelMessage[] and wraps tool schemas in jsonSchema()", async () => {
    generateText.mockResolvedValueOnce({
      toolCalls: [],
      text: "ok",
    });
    const result = await runWith(
      Effect.flatMap(LLMService, (s) => s.runToolCalling(baseRequest)),
    );
    expect(result._tag).toBe("Success");

    expect(generateText).toHaveBeenCalledOnce();
    const arg = generateText.mock.calls[0]![0] as {
      system: string;
      messages: ReadonlyArray<{ role: string; content: unknown }>;
      tools: Record<string, { description: string; inputSchema: unknown }>;
      model: { __chat: string };
    };
    expect(arg.system).toBe("you are a test");
    expect(arg.messages).toEqual([
      { role: "user", content: "where is my order?" },
    ]);
    expect(Object.keys(arg.tools)).toEqual(["case.update_status"]);
    expect(arg.tools["case.update_status"]!.description).toBe(
      "transition the case",
    );
    // jsonSchema() wraps the raw JSON schema so the SDK doesn't introspect.
    expect(arg.tools["case.update_status"]!.inputSchema).toEqual({
      __wrapped: { type: "object", properties: { to: { type: "string" } } },
    });
    expect(arg.model.__chat).toBe("google/gemini-3.1-flash-lite");
  });

  it("translates assistant tool-call replays and tool-result messages", async () => {
    generateText.mockResolvedValueOnce({
      toolCalls: [],
      text: "done",
    });
    const messages: ReadonlyArray<ChatMessage> = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "thinking",
        toolCalls: [
          { id: "c1", name: "case.update_status", input: { to: "resolved" } },
        ],
      },
      {
        role: "tool",
        toolCallId: "c1",
        toolName: "case.update_status",
        content: { ok: true },
      },
    ];
    await runWith(
      Effect.flatMap(LLMService, (s) =>
        s.runToolCalling({ ...baseRequest, messages }),
      ),
    );
    const arg = generateText.mock.calls[0]![0] as {
      messages: ReadonlyArray<{ role: string; content: unknown }>;
    };
    // Assistant gets split into a text + tool-call parts array.
    expect(arg.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "thinking" },
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "case.update_status",
          input: { to: "resolved" },
        },
      ],
    });
    // Tool role wraps the content as a tool-result with output.type === json.
    expect(arg.messages[2]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "case.update_status",
          output: { type: "json", value: { ok: true } },
        },
      ],
    });
  });

  it("translates user image content parts into AI SDK image parts with bytes + mediaType", async () => {
    // When the runtime emits a multimodal user message (damaged-product
    // flow), the LLM service must fetch each image's bytes from
    // BlobStorage and project to `{ type: "image", image, mediaType }`.
    generateText.mockResolvedValueOnce({ toolCalls: [], text: "looking" });
    const bytes1 = new Uint8Array([1, 2, 3]);
    const bytes2 = new Uint8Array([9, 8, 7, 6]);
    const blobLayer = BlobStorageTest({
      seed: {
        "evidence/photo1.jpg": { bytes: bytes1, contentType: "image/jpeg" },
        "evidence/photo2.png": { bytes: bytes2, contentType: "image/png" },
      },
    });
    const messages: ReadonlyArray<ChatMessage> = [
      {
        role: "user",
        content: [
          { type: "text", text: "see attached" },
          {
            type: "image",
            attachment: {
              filename: "p1.jpg",
              contentType: "image/jpeg",
              storageKey: "evidence/photo1.jpg",
              sizeBytes: 3,
            },
          },
          {
            type: "image",
            attachment: {
              filename: "p2.png",
              contentType: "image/png",
              storageKey: "evidence/photo2.png",
              sizeBytes: 4,
            },
          },
        ],
      },
    ];
    await runWith(
      Effect.flatMap(LLMService, (s) =>
        s.runToolCalling({ ...baseRequest, messages }),
      ),
      blobLayer,
    );
    const arg = generateText.mock.calls[0]![0] as {
      messages: ReadonlyArray<{ role: string; content: unknown }>;
    };
    expect(arg.messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "see attached" },
        { type: "image", image: bytes1, mediaType: "image/jpeg" },
        { type: "image", image: bytes2, mediaType: "image/png" },
      ],
    });
  });

  it("maps a BlobNotFound during image fetch to NetworkError so the runtime can escalate", async () => {
    const blobLayer = BlobStorageTest({}); // empty store
    const messages: ReadonlyArray<ChatMessage> = [
      {
        role: "user",
        content: [
          { type: "text", text: "see attached" },
          {
            type: "image",
            attachment: {
              filename: "missing.jpg",
              contentType: "image/jpeg",
              storageKey: "evidence/missing.jpg",
              sizeBytes: 1,
            },
          },
        ],
      },
    ];
    const exit = await runWith(
      Effect.flatMap(LLMService, (s) =>
        s.runToolCalling({ ...baseRequest, messages }),
      ),
      blobLayer,
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    if (exit.cause._tag !== "Fail") throw new Error("expected Fail cause");
    expect(exit.cause.error).toBeInstanceOf(NetworkError);
    // generateText must NOT have been called — we failed before dispatch.
    expect(generateText).not.toHaveBeenCalled();
  });
});

describe("LLMServiceLive — decision mapping", () => {
  it("returns a tool_call decision when the SDK returns a tool call", async () => {
    generateText.mockResolvedValueOnce({
      toolCalls: [
        {
          toolCallId: "call-1",
          toolName: "case.update_status",
          input: { to: "resolved" },
        },
      ],
      text: "",
    });
    const exit = await runWith(
      Effect.flatMap(LLMService, (s) => s.runToolCalling(baseRequest)),
    );
    expect(exit._tag).toBe("Success");
    if (exit._tag !== "Success") return;
    expect(exit.value).toEqual({
      type: "tool_call",
      callId: "call-1",
      tool: "case.update_status",
      input: { to: "resolved" },
    });
  });

  it("returns final_message when the SDK returns plain text", async () => {
    generateText.mockResolvedValueOnce({
      toolCalls: [],
      text: "Your order shipped Tuesday.",
    });
    const exit = await runWith(
      Effect.flatMap(LLMService, (s) => s.runToolCalling(baseRequest)),
    );
    expect(exit._tag).toBe("Success");
    if (exit._tag !== "Success") return;
    expect(exit.value).toEqual({
      type: "final_message",
      text: "Your order shipped Tuesday.",
    });
  });

  it("attaches token usage on the decision when the SDK reports it", async () => {
    generateText.mockResolvedValueOnce({
      toolCalls: [],
      text: "ok",
      usage: { inputTokens: 123, outputTokens: 45, totalTokens: 168 },
    });
    const exit = await runWith(
      Effect.flatMap(LLMService, (s) => s.runToolCalling(baseRequest)),
    );
    expect(exit._tag).toBe("Success");
    if (exit._tag !== "Success") return;
    expect(exit.value.type).toBe("final_message");
    if (exit.value.type === "final_message") {
      expect(exit.value.usage).toEqual({
        model: baseRequest.model,
        provider: "openrouter",
        inputTokens: 123,
        outputTokens: 45,
      });
    }
  });

  it("falls back to legacy promptTokens / completionTokens field names", async () => {
    generateText.mockResolvedValueOnce({
      toolCalls: [],
      text: "ok",
      usage: { promptTokens: 50, completionTokens: 20 },
    });
    const exit = await runWith(
      Effect.flatMap(LLMService, (s) => s.runToolCalling(baseRequest)),
    );
    expect(exit._tag).toBe("Success");
    if (exit._tag !== "Success") return;
    if (exit.value.type === "final_message") {
      expect(exit.value.usage?.inputTokens).toBe(50);
      expect(exit.value.usage?.outputTokens).toBe(20);
    }
  });

  it("omits usage from the decision when the SDK didn't report any", async () => {
    generateText.mockResolvedValueOnce({
      toolCalls: [],
      text: "ok",
      // no `usage` key
    });
    const exit = await runWith(
      Effect.flatMap(LLMService, (s) => s.runToolCalling(baseRequest)),
    );
    expect(exit._tag).toBe("Success");
    if (exit._tag !== "Success") return;
    // Backwards-compat assertion: the existing decision shape is unchanged.
    expect(exit.value).toEqual({
      type: "final_message",
      text: "ok",
    });
  });
});

// Regression tests for the Anthropic-specific fixes that landed during
// the 2026-05-16 live demo. Anthropic's API rejects dot-containing tool
// names (regex `^[a-zA-Z0-9_-]{1,128}$`), and OpenRouter routes Anthropic
// models across multiple backends (Anthropic native, Amazon Bedrock,
// Google Vertex) all of which enforce the same regex. The LLM service:
//  1. sanitizes dots → underscores in tool schemas + tool-call references
//     in conversation history when the model is `anthropic/*`,
//  2. reverse-maps the underscored names back to the original on inbound,
//  3. pins `anthropic/*` requests to the native Anthropic endpoint via
//     `provider: { only: ["anthropic"], allow_fallbacks: false }`.
describe("LLMServiceLive — Anthropic tool-name sanitization + routing", () => {
  const anthropicRequest: ToolCallingRequest = {
    tenantId: testTenantId,
    model: "anthropic/claude-haiku-4.5",
    system: "you are claude",
    messages: [
      { role: "user", content: "hi" } satisfies ChatMessage,
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call-a", name: "case.update_context", input: { x: 1 } },
        ],
      },
      {
        role: "tool",
        toolCallId: "call-a",
        toolName: "case.update_context",
        content: { ok: true },
      },
    ],
    tools: [
      {
        name: "case.update_context",
        description: "update context",
        inputSchema: { type: "object" },
      },
      {
        name: "shopify.get_order",
        description: "get an order",
        inputSchema: { type: "object" },
      },
    ],
  };

  it("rewrites dot tool names to underscores in tool schemas for anthropic/* models", async () => {
    generateText.mockResolvedValueOnce({ toolCalls: [], text: "ok" });
    await runWith(
      Effect.flatMap(LLMService, (s) => s.runToolCalling(anthropicRequest)),
    );
    const arg = generateText.mock.calls[0]![0] as {
      tools: Record<string, unknown>;
    };
    const toolNames = Object.keys(arg.tools).sort();
    // Anthropic sees ONLY the underscored names — the dotted ones would
    // be rejected with `tools.0.custom.name: String should match
    // pattern '^[a-zA-Z0-9_-]{1,128}$'`.
    expect(toolNames).toEqual(["case_update_context", "shopify_get_order"]);
    expect(arg.tools["case.update_context"]).toBeUndefined();
  });

  it("rewrites tool-call + tool-result toolName references in conversation history for anthropic/* models", async () => {
    generateText.mockResolvedValueOnce({ toolCalls: [], text: "ok" });
    await runWith(
      Effect.flatMap(LLMService, (s) => s.runToolCalling(anthropicRequest)),
    );
    const arg = generateText.mock.calls[0]![0] as {
      messages: ReadonlyArray<{ role: string; content: unknown }>;
    };
    // assistant message: tool-call must reference the sanitized name to
    // pair with the schema; otherwise Anthropic returns
    // `tools.*: Invalid tool name`.
    const assistant = arg.messages[1] as {
      content: ReadonlyArray<{ type: string; toolName?: string }>;
    };
    const toolCallEntry = assistant.content.find((c) => c.type === "tool-call");
    expect(toolCallEntry?.toolName).toBe("case_update_context");
    // tool message: tool-result must also reference the sanitized name.
    const toolMsg = arg.messages[2] as {
      content: ReadonlyArray<{ type: string; toolName?: string }>;
    };
    const toolResultEntry = toolMsg.content.find(
      (c) => c.type === "tool-result",
    );
    expect(toolResultEntry?.toolName).toBe("case_update_context");
  });

  it("reverse-maps the sanitized tool name when the SDK returns a tool_call for an anthropic/* model", async () => {
    generateText.mockResolvedValueOnce({
      toolCalls: [
        {
          toolCallId: "call-2",
          toolName: "shopify_get_order",
          input: { orderId: "1001" },
        },
      ],
      text: "",
    });
    const exit = await runWith(
      Effect.flatMap(LLMService, (s) => s.runToolCalling(anthropicRequest)),
    );
    expect(exit._tag).toBe("Success");
    if (exit._tag !== "Success") return;
    // The internal `LLMDecision` must carry the ORIGINAL dotted name so
    // downstream code (ToolRegistry.tryGet, audit log, prompts) keeps
    // working unchanged.
    expect(exit.value).toEqual({
      type: "tool_call",
      callId: "call-2",
      tool: "shopify.get_order",
      input: { orderId: "1001" },
    });
  });

  it("pins anthropic/* models to the native Anthropic endpoint via provider.only", async () => {
    generateText.mockResolvedValueOnce({ toolCalls: [], text: "ok" });
    await runWith(
      Effect.flatMap(LLMService, (s) => s.runToolCalling(anthropicRequest)),
    );
    const arg = generateText.mock.calls[0]![0] as {
      model: { __chatSettings?: { provider?: unknown } };
    };
    // Without `only: ["anthropic"]`, OpenRouter is free to route the call
    // to Amazon Bedrock — which enforces the same tool-name regex but
    // surfaces errors as "[Amazon Bedrock] tools.0.custom.name..." that
    // are harder to recognize.
    expect(arg.model.__chatSettings).toEqual({
      provider: {
        only: ["anthropic"],
        allow_fallbacks: false,
      },
    });
  });

  it("does NOT sanitize tool names or pin routing for non-anthropic models", async () => {
    generateText.mockResolvedValueOnce({ toolCalls: [], text: "ok" });
    await runWith(
      Effect.flatMap(LLMService, (s) =>
        s.runToolCalling({
          ...anthropicRequest,
          model: "google/gemini-3-flash-preview",
        }),
      ),
    );
    const arg = generateText.mock.calls[0]![0] as {
      tools: Record<string, unknown>;
      model: { __chatSettings?: unknown };
    };
    // Tool names pass through unchanged for non-Anthropic providers.
    expect(Object.keys(arg.tools).sort()).toEqual([
      "case.update_context",
      "shopify.get_order",
    ]);
    // No provider routing pin for non-Anthropic — `chatSettings` is
    // undefined because we call `provider.chat(model)` with no second
    // argument for non-Anthropic models.
    expect(arg.model.__chatSettings).toBeUndefined();
  });
});

describe("LLMServiceLive — error mapping", () => {
  it("maps 5xx and 429 → ProviderUnavailable", async () => {
    for (const status of [503, 429] as const) {
      const e = new Error(`status ${status}`);
      (e as unknown as { statusCode: number }).statusCode = status;
      generateText.mockReset();
      generateText.mockRejectedValueOnce(e);
      const exit = await runWith(
        Effect.flatMap(LLMService, (s) =>
          s.runToolCalling(baseRequest).pipe(
            Effect.catchAll((err) => Effect.succeed(err)),
          ),
        ),
      );
      expect(exit._tag).toBe("Success");
      if (exit._tag !== "Success") return;
      expect(exit.value).toBeInstanceOf(ProviderUnavailable);
    }
  });

  it("maps context-length messages → ContextTooLarge", async () => {
    const e = new Error("This model's maximum context length is 200000 tokens.");
    generateText.mockReset();
    generateText.mockRejectedValueOnce(e);
    const exit = await runWith(
      Effect.flatMap(LLMService, (s) =>
        s.runToolCalling(baseRequest).pipe(
          Effect.catchAll((err) => Effect.succeed(err)),
        ),
      ),
    );
    expect(exit._tag).toBe("Success");
    if (exit._tag !== "Success") return;
    expect(exit.value).toBeInstanceOf(ContextTooLarge);
  });

  it("maps safety/content-policy messages → SafetyBlocked", async () => {
    generateText.mockReset();
    generateText.mockRejectedValueOnce(new Error("Blocked by safety filter"));
    const exit = await runWith(
      Effect.flatMap(LLMService, (s) =>
        s.runToolCalling(baseRequest).pipe(
          Effect.catchAll((err) => Effect.succeed(err)),
        ),
      ),
    );
    expect(exit._tag).toBe("Success");
    if (exit._tag !== "Success") return;
    expect(exit.value).toBeInstanceOf(SafetyBlocked);
  });

  it("maps a 402 / insufficient-credit error → InsufficientCredits (terminal, NOT a retryable provider error)", async () => {
    // A prepaid OpenRouter key at zero balance is rejected with HTTP 402.
    // This must NOT map to ProviderUnavailable/NetworkError (which the runtime
    // treats as retryable and would burn 5 retries → opaque dead-letter); it is
    // deterministic until the merchant tops up, so it parks for a human.
    const byStatus = new Error("Payment Required");
    (byStatus as unknown as { statusCode: number }).statusCode = 402;
    generateText.mockReset();
    generateText.mockRejectedValueOnce(byStatus);
    let exit = await runWith(
      Effect.flatMap(LLMService, (s) =>
        s.runToolCalling(baseRequest).pipe(Effect.catchAll((err) => Effect.succeed(err))),
      ),
    );
    expect(exit._tag).toBe("Success");
    if (exit._tag !== "Success") return;
    expect(exit.value).toBeInstanceOf(InsufficientCredits);

    // Providers that don't stamp a statusCode still surface a credit message.
    generateText.mockReset();
    generateText.mockRejectedValueOnce(
      new Error(
        "This request requires more credits, or fewer max_tokens. You requested up to 4096 tokens, but can only afford 0.",
      ),
    );
    exit = await runWith(
      Effect.flatMap(LLMService, (s) =>
        s.runToolCalling(baseRequest).pipe(Effect.catchAll((err) => Effect.succeed(err))),
      ),
    );
    expect(exit._tag).toBe("Success");
    if (exit._tag !== "Success") return;
    expect(exit.value).toBeInstanceOf(InsufficientCredits);
  });

  it("maps unknown errors → NetworkError", async () => {
    generateText.mockReset();
    generateText.mockRejectedValueOnce(new Error("socket hang up"));
    const exit = await runWith(
      Effect.flatMap(LLMService, (s) =>
        s.runToolCalling(baseRequest).pipe(
          Effect.catchAll((err) => Effect.succeed(err)),
        ),
      ),
    );
    expect(exit._tag).toBe("Success");
    if (exit._tag !== "Success") return;
    expect(exit.value).toBeInstanceOf(NetworkError);
  });
});

// BYOK: the live layer reads the per-tenant credential from
// LLMCredentialResolver and picks the matching AI SDK adapter
// (OpenRouter / Anthropic / OpenAI). The mocks above stamp a
// `__providerKind` field onto the returned model handle so we can assert
// which adapter was actually used.
describe("LLMServiceLive — per-provider adapter selection (BYOK)", () => {
  const tenantOpenRouter = TenantId("00000000-0000-0000-0000-0000000000a1");
  const tenantAnthropic = TenantId("00000000-0000-0000-0000-0000000000a2");
  const tenantOpenAI = TenantId("00000000-0000-0000-0000-0000000000a3");

  const layer = LLMServiceLive.pipe(
    Layer.provide(
      Layer.merge(
        LLMCredentialResolverTest(
          new Map<TenantId, LLMCredential>([
            [tenantOpenRouter, { provider: "openrouter", apiKey: "or-key" }],
            [tenantAnthropic, { provider: "anthropic", apiKey: "ant-key" }],
            [tenantOpenAI, { provider: "openai", apiKey: "oa-key" }],
          ]),
        ),
        BlobStorageTest({}),
      ),
    ),
  );

  const minimalReq = (
    tid: TenantId,
    model: string,
  ): ToolCallingRequest => ({
    tenantId: tid,
    model,
    system: "test",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
  });

  it("dispatches to the OpenRouter adapter for an openrouter-keyed tenant", async () => {
    generateText.mockReset();
    generateText.mockResolvedValueOnce({ toolCalls: [], text: "ok" });
    await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(LLMService, (s) =>
          s.runToolCalling(
            minimalReq(tenantOpenRouter, "google/gemini-3.1-flash-lite"),
          ),
        ),
        layer,
      ),
    );
    const args = generateText.mock.calls[0]?.[0] as {
      model: { __providerKind?: string };
    };
    expect(args.model.__providerKind).toBe("openrouter");
  });

  it("dispatches to the native Anthropic adapter for an anthropic-keyed tenant", async () => {
    generateText.mockReset();
    generateText.mockResolvedValueOnce({ toolCalls: [], text: "ok" });
    await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(LLMService, (s) =>
          s.runToolCalling(minimalReq(tenantAnthropic, "claude-haiku-4.5")),
        ),
        layer,
      ),
    );
    const args = generateText.mock.calls[0]?.[0] as {
      model: { __providerKind?: string; __chat?: string };
    };
    expect(args.model.__providerKind).toBe("anthropic");
    expect(args.model.__chat).toBe("claude-haiku-4.5");
  });

  it("dispatches to the native OpenAI adapter for an openai-keyed tenant", async () => {
    generateText.mockReset();
    generateText.mockResolvedValueOnce({ toolCalls: [], text: "ok" });
    await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(LLMService, (s) =>
          s.runToolCalling(minimalReq(tenantOpenAI, "gpt-4o-mini")),
        ),
        layer,
      ),
    );
    const args = generateText.mock.calls[0]?.[0] as {
      model: { __providerKind?: string; __chat?: string };
    };
    expect(args.model.__providerKind).toBe("openai");
    expect(args.model.__chat).toBe("gpt-4o-mini");
  });

  it("hard-fails with LLMCredentialMissing for a tenant with no key", async () => {
    const missingTenant = TenantId("00000000-0000-0000-0000-00000000ffff");
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.flatMap(LLMService, (s) =>
          s
            .runToolCalling(minimalReq(missingTenant, "anything"))
            .pipe(Effect.catchAll((err) => Effect.succeed(err))),
        ),
        layer,
      ),
    );
    expect(exit._tag).toBe("Success");
    if (exit._tag !== "Success") return;
    expect((exit.value as { _tag: string })._tag).toBe(
      "LLMCredentialMissing",
    );
  });
});
