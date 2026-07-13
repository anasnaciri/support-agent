import type { AgentId, TenantId } from "./ids.js";
import type {
  MessageAttachment,
  OutboundMessageDraft,
  FulfillmentOperatorEscalationPayload,
} from "./payloads.js";

export type JsonSchema = Readonly<Record<string, unknown>>;

export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

/**
 * Content parts for a multimodal user message. The runtime emits these
 * when an inbound message carries image attachments — the LLM provider
 * boundary translates each `image` part into the provider's native
 * vision payload (Vercel AI SDK `{ type: "image", image, mediaType }`).
 *
 * Today only `text` + `image` are modelled. `image` references an
 * uploaded `MessageAttachment` by storage key + contentType; the
 * provider layer fetches the bytes from `BlobStorage` on demand so we
 * don't carry binary blobs through the runtime / audit log.
 */
export type UserContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly attachment: MessageAttachment };

export type ChatMessage =
  | {
      readonly role: "user";
      readonly content: string | ReadonlyArray<UserContentPart>;
    }
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly toolCalls?: ReadonlyArray<{
        readonly id: string;
        readonly name: string;
        readonly input: unknown;
      }>;
    }
  | {
      readonly role: "tool";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly content: unknown;
    };

export interface ToolCallingRequest {
  /**
   * BYOK: the live LLMService consults LLMCredentialResolver(tenantId) to
   * pick the per-tenant API key + provider on every call. Test layers ignore
   * this field — they don't need credentials.
   */
  readonly tenantId: TenantId;
  readonly model: string;
  readonly system: string;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly tools: ReadonlyArray<ToolSchema>;
  readonly maxTokens?: number;
  readonly temperature?: number;
}

/**
 * Token usage for one LLM call. Populated by the Live LLMService from
 * the AI SDK's `result.usage`. Test layers (Scripted, FromFn) leave it
 * undefined — token bookkeeping doesn't need to be exercised in unit
 * tests. The runtime stamps it into the `llm.decision` audit row's
 * `details` so the ticket detail page can roll up totals on read.
 *
 * Cost in dollars is deferred (Phase 6 cost dashboard work): translating
 * tokens to USD needs a per-model pricing table that varies by provider.
 * Tokens-as-units gets us the structural data; conversion is downstream.
 */
export interface LLMUsage {
  readonly model: string;
  readonly provider?: "openrouter" | "anthropic" | "openai";
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export type LLMDecision =
  | {
      readonly type: "tool_call";
      readonly callId: string;
      readonly tool: string;
      readonly input: unknown;
      readonly reasoning?: string;
      readonly usage?: LLMUsage;
    }
  | {
      readonly type: "final_message";
      readonly text: string;
      readonly reasoning?: string;
      readonly usage?: LLMUsage;
    }
  | {
      readonly type: "handoff";
      readonly targetAgent: AgentId;
      readonly reason: string;
      readonly usage?: LLMUsage;
    }
  | {
      readonly type: "wait_for_customer";
      readonly message: OutboundMessageDraft;
      readonly usage?: LLMUsage;
    }
  | {
      readonly type: "escalate_fulfillment_operator";
      readonly payload: FulfillmentOperatorEscalationPayload;
      readonly usage?: LLMUsage;
    };
