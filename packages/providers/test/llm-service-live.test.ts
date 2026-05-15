import { Effect, Layer } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContextTooLarge,
  NetworkError,
  ProviderUnavailable,
  SafetyBlocked,
  type ChatMessage,
  type ToolCallingRequest,
} from "@support-agent/agent-core";
import { LLMConfig, LLMService } from "@support-agent/services";

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
    (provider as unknown as { chat: unknown }).chat = (modelId: string) => ({
      __chat: modelId,
      __providerOpts: opts,
    });
    return provider;
  },
}));

// Defer importing the live layer until after the mocks are registered.
const { LLMServiceLive } = await import("../src/llm-service-live.js");

// ---------- Helpers ----------------------------------------------------------

const cfgLayer = Layer.succeed(
  LLMConfig,
  LLMConfig.of({ apiKey: "test-key", siteName: "support-agent-test" }),
);

const runWith = <A, E>(eff: Effect.Effect<A, E, LLMService>) =>
  Effect.runPromiseExit(
    Effect.provide(eff, LLMServiceLive.pipe(Layer.provide(cfgLayer))),
  );

const baseRequest: ToolCallingRequest = {
  model: "anthropic/claude-3.5-sonnet",
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
    expect(arg.model.__chat).toBe("anthropic/claude-3.5-sonnet");
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
