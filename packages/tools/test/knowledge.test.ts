import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentId,
  CaseId,
  TenantId,
  type ToolContext,
} from "@support-agent/agent-core";
import { KnowledgeBaseServiceTest } from "@support-agent/services";
import { knowledgeSearch } from "../src/index.js";

const tenantId = TenantId("00000000-0000-0000-0000-0000000000aa");
const baseCtx: ToolContext = {
  tenantId,
  caseId: CaseId("c-1"),
  agentId: AgentId("refund-review-agent"),
  callId: "call_1",
  attemptNumber: 1,
};

const seed = [
  {
    tenantId,
    title: "Shipping policy",
    content: "Orders ship within 3 business days via standard post.",
    sourceType: "text" as const,
  },
  {
    tenantId,
    title: "Returns policy",
    content:
      "Items may be returned within 30 days of delivery for a full refund.",
    sourceType: "text" as const,
  },
];

const runSearch = (query: string, layer = KnowledgeBaseServiceTest(seed)) =>
  Effect.runPromiseExit(
    Effect.provide(
      knowledgeSearch.execute({ query } as never, baseCtx) as Effect.Effect<
        unknown,
        unknown,
        never
      >,
      layer,
    ),
  );

describe("knowledge.search tool", () => {
  it("returns the most relevant document for a query", async () => {
    const exit = await runSearch("how long is the refund window");
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const out = exit.value as {
      results: ReadonlyArray<{ id: string; title: string; content: string }>;
    };
    expect(out.results[0]?.title).toBe("Returns policy");
    expect(out.results[0]?.content).toContain("30 days");
  });

  it("returns an empty result set when the tenant has no documents", async () => {
    const exit = await runSearch("anything", KnowledgeBaseServiceTest());
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const out = exit.value as { results: ReadonlyArray<unknown> };
    expect(out.results).toEqual([]);
  });

  it("is an internal read tool — no tenantControl / display metadata", () => {
    expect(knowledgeSearch.name).toBe("knowledge.search");
    expect(knowledgeSearch.risk).toBe("read");
    expect(knowledgeSearch.defaultPermission).toBe("allow");
    expect(
      (knowledgeSearch as { tenantControl?: unknown }).tenantControl,
    ).toBeUndefined();
    expect(
      (knowledgeSearch as { displayName?: unknown }).displayName,
    ).toBeUndefined();
  });
});
