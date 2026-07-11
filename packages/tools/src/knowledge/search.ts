import { Effect, Schema } from "effect";
import {
  defineTool,
  ToolOutputInvalid,
  wrapUntrusted,
} from "@support-agent/agent-core";
import { KnowledgeBaseService, rankKnowledge } from "@support-agent/services";

const Input = Schema.Struct({
  query: Schema.String,
});

const Output = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      content: Schema.String,
    }),
  ),
});

export const knowledgeSearch = defineTool({
  name: "knowledge.search",
  description:
    "Search the store's knowledge base: the merchant's own policy and reference documents (shipping policy, returns/refund policy, FAQs, …). Pass the customer's question or a few keywords as `query`; returns the most relevant documents with their text. Call this BEFORE answering a policy question or recommending a refund, and ground your reply in what it returns rather than assuming a generic policy. Returns an empty list when the store has no documents.",
  inputSchema: Input,
  outputSchema: Output,
  // Read-only and always allowed: it only reads the merchant's own documents.
  // No `tenantControl`/`displayName` — it's internal plumbing, not a
  // tenant-configurable outward action, so it stays out of the agent
  // "Actions" UI.
  risk: "read",
  defaultPermission: "allow",
  sideEffectClass: "none",
  execute: (input, ctx) =>
    Effect.gen(function* () {
      const kb = yield* KnowledgeBaseService;
      const docs = yield* kb.listFull(ctx.tenantId).pipe(
        Effect.mapError(
          (e) =>
            new ToolOutputInvalid({
              tool: "knowledge.search",
              issues: [e._tag],
            }),
        ),
      );
      const ranked = rankKnowledge(
        input.query,
        docs.map((d) => ({ id: d.id, title: d.title, content: d.content })),
      );
      return {
        results: ranked.map((r) => ({
          id: r.id,
          title: r.title,
          // The document body is merchant-pasted or URL-snapshotted prose —
          // untrusted. Fence it so a poisoned document's "instructions" land
          // as inert data inside the model's untrusted boundary.
          content: wrapUntrusted(r.snippet),
        })),
      };
    }),
});
