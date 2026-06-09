import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { ShopifyAuthMissing, TenantId } from "@support-agent/agent-core";
import {
  KnowledgeBaseService,
  KnowledgeBaseServiceTest,
  ShopifyServiceTest,
  type KnowledgeDocument,
  type ShopPolicy,
} from "@support-agent/services";
import {
  importShopifyPolicies,
  runShopifyPolicyImport,
} from "../src/shopify-policy-import.js";

const tenantId = TenantId("t-policy");

const policy = (over: Partial<ShopPolicy> = {}): ShopPolicy => ({
  type: "REFUND_POLICY",
  title: "Refund Policy",
  body: "<p>Returns within 30 days.</p>",
  url: "https://shop.example/policies/refund-policy",
  ...over,
});

const shippingPolicy = policy({
  type: "SHIPPING_POLICY",
  title: "Shipping Policy",
  body: "<p>Ships in 3 business days.</p>",
  url: "https://shop.example/policies/shipping-policy",
});

/** A KB seed row carrying everything the in-memory Test layer needs. */
const toSeed = (d: KnowledgeDocument) => ({
  tenantId,
  id: d.id,
  title: d.title,
  content: d.content,
  sourceType: d.sourceType,
  sourceUrl: d.sourceUrl,
  contentHash: d.contentHash,
  fetchedAt: d.fetchedAt,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
});

/** Run the import and read the resulting KB back, in one provided scope. */
const runWithKb = (
  policies: ReadonlyArray<ShopPolicy>,
  kbSeed: ReadonlyArray<ReturnType<typeof toSeed>> = [],
) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const result = yield* importShopifyPolicies(tenantId);
        const kb = yield* KnowledgeBaseService;
        const docs = yield* kb.listFull(tenantId);
        return { result, docs };
      }),
      Layer.merge(
        ShopifyServiceTest({ shopPolicies: () => Effect.succeed(policies) }),
        KnowledgeBaseServiceTest(kbSeed),
      ),
    ),
  );

describe("importShopifyPolicies", () => {
  it("creates url docs for the shipping and refund policies", async () => {
    const { result, docs } = await runWithKb([policy(), shippingPolicy]);

    expect(result).toEqual({ created: 2, updated: 0, skipped: 0 });
    expect(docs).toHaveLength(2);
    for (const d of docs) {
      expect(d.sourceType).toBe("url");
      expect(d.contentHash).toBeTruthy();
      expect(d.fetchedAt).toBeInstanceOf(Date);
      // HTML is converted to readable text — no angle-bracket tags survive.
      expect(d.content).not.toContain("<p>");
    }
    const refund = docs.find(
      (d) => d.sourceUrl === "https://shop.example/policies/refund-policy",
    );
    expect(refund?.content).toContain("Returns within 30 days.");
  });

  it("ignores policy types that aren't shipping or refund", async () => {
    const privacy = policy({
      type: "PRIVACY_POLICY",
      title: "Privacy Policy",
      body: "<p>We respect your privacy.</p>",
      url: "https://shop.example/policies/privacy-policy",
    });
    const { result, docs } = await runWithKb([privacy, policy()]);

    expect(result.created).toBe(1);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.sourceUrl).toBe(
      "https://shop.example/policies/refund-policy",
    );
  });

  it("no-ops when the store has no policies configured", async () => {
    const { result, docs } = await runWithKb([]);
    expect(result).toEqual({ created: 0, updated: 0, skipped: 0 });
    expect(docs).toHaveLength(0);
  });

  it("skips a policy whose body is empty", async () => {
    const { result, docs } = await runWithKb([policy({ body: "<p></p>" })]);
    expect(result).toEqual({ created: 0, updated: 0, skipped: 1 });
    expect(docs).toHaveLength(0);
  });

  it("skips re-import when the policy content is unchanged (dedup by url)", async () => {
    const first = await runWithKb([policy()]);
    expect(first.result.created).toBe(1);

    const second = await runWithKb([policy()], first.docs.map(toSeed));
    expect(second.result).toEqual({ created: 0, updated: 0, skipped: 1 });
    expect(second.docs).toHaveLength(1);
  });

  it("updates the existing doc when the policy content changed", async () => {
    const first = await runWithKb([policy({ body: "<p>Old text.</p>" })]);

    const second = await runWithKb(
      [policy({ body: "<p>Brand new policy text.</p>" })],
      first.docs.map(toSeed),
    );
    expect(second.result).toEqual({ created: 0, updated: 1, skipped: 0 });
    expect(second.docs).toHaveLength(1);
    expect(second.docs[0]!.content).toContain("Brand new policy text.");
  });

  it("does not overwrite a merchant-authored doc at a different url", async () => {
    const hand = toSeed({
      id: "hand-1",
      title: "My own notes",
      content: "internal escalation steps",
      sourceType: "text",
      sourceUrl: null,
      contentHash: null,
      fetchedAt: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    const { result, docs } = await runWithKb([policy()], [hand]);
    expect(result.created).toBe(1);
    expect(docs).toHaveLength(2);
    expect(docs.some((d) => d.id === "hand-1")).toBe(true);
  });
});

describe("runShopifyPolicyImport (silent boundary)", () => {
  it("fails silently when the Shopify fetch errors", async () => {
    const result = await Effect.runPromise(
      Effect.provide(
        runShopifyPolicyImport(tenantId),
        Layer.merge(
          ShopifyServiceTest({
            shopPolicies: () =>
              Effect.fail(new ShopifyAuthMissing({ tenantId })),
          }),
          KnowledgeBaseServiceTest([]),
        ),
      ),
    );
    // Resolves (void) instead of throwing — the connect flow is never broken.
    expect(result).toBeUndefined();
  });
});
