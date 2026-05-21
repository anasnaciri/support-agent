import type { AgentId, TenantId } from "./ids.js";
import type { OutboundMessageDraft, SupplierEscalationPayload } from "./payloads.js";

export type JsonSchema = Readonly<Record<string, unknown>>;

export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

export type ChatMessage =
  | { readonly role: "user"; readonly content: string }
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

export type LLMDecision =
  | {
      readonly type: "tool_call";
      readonly callId: string;
      readonly tool: string;
      readonly input: unknown;
      readonly reasoning?: string;
    }
  | {
      readonly type: "final_message";
      readonly text: string;
      readonly reasoning?: string;
    }
  | {
      readonly type: "handoff";
      readonly targetAgent: AgentId;
      readonly reason: string;
    }
  | {
      readonly type: "wait_for_customer";
      readonly message: OutboundMessageDraft;
    }
  | {
      readonly type: "escalate_supplier";
      readonly payload: SupplierEscalationPayload;
    };
