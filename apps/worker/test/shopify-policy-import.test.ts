import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { ShopifyAuthMissing, TenantId } from "@support-agent/agent-core";
import {
  KnowledgeBaseService,
  KnowledgeBaseServiceTest,
  ShopifyServiceTest,
  type KnowledgeDocument,
  type ShopInfo,
  type ShopPage,
  type ShopPolicy,
} from "@support-agent/services";
import {
  importShopifyPages,
  importShopifyPolicies,
  runShopifyPolicyImport,
  selectImportablePages,
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

  it("still imports policies when the pages fetch fails (e.g. scope not yet granted)", async () => {
    // Existing installs don't have read_online_store_pages until the
    // merchant re-OAuths — the page leg failing must not cost the
    // policy import.
    const docs = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* runShopifyPolicyImport(tenantId);
          const kb = yield* KnowledgeBaseService;
          return yield* kb.listFull(tenantId);
        }),
        Layer.merge(
          ShopifyServiceTest({
            shopPolicies: () => Effect.succeed([policy()]),
            onlineStorePages: () =>
              Effect.fail(new ShopifyAuthMissing({ tenantId })),
          }),
          KnowledgeBaseServiceTest([]),
        ),
      ),
    );
    expect(docs).toHaveLength(1);
    expect(docs[0]!.sourceUrl).toBe(
      "https://shop.example/policies/refund-policy",
    );
  });
});

// ============================================================
// Page import (About / Contact / FAQ)
// ============================================================

const page = (over: Partial<ShopPage> = {}): ShopPage => ({
  title: "FAQ",
  handle: "faq",
  body: "<p>How long is shipping? 3 days.</p>",
  isPublished: true,
  ...over,
});

const shopInfo: ShopInfo = {
  name: "Test Shop",
  contactEmail: "hello@shop.example",
  primaryDomainUrl: "https://shop.example",
  currencyCode: "EUR",
  shipsToCountries: ["DE"],
};

describe("selectImportablePages (conservative heuristic)", () => {
  const titles = (pages: ReadonlyArray<ShopPage>) =>
    selectImportablePages(pages).map((p) => p.title);

  it("matches About / Contact / FAQ by handle or title, tolerant of case and punctuation", () => {
    const pages = [
      page({ title: "About Us", handle: "about-us" }),
      page({ title: "Get in touch", handle: "contact" }),
      page({ title: "F.A.Q.", handle: "info" }),
      page({ title: "Frequently Asked Questions", handle: "help-center" }),
    ];
    expect(titles(pages)).toEqual([
      "About Us",
      "Get in touch",
      "F.A.Q.",
      "Frequently Asked Questions",
    ]);
  });

  it("under-imports by design: unrelated and merchant-internal pages never match", () => {
    const pages = [
      page({ title: "Wholesale pricing", handle: "wholesale-pricing" }),
      page({ title: "Our blog", handle: "blog" }),
      page({ title: "Affiliate program", handle: "affiliates" }),
      // "about" embedded in a longer name is NOT a match — conservative.
      page({ title: "About our suppliers", handle: "about-our-suppliers" }),
    ];
    expect(titles(pages)).toEqual([]);
  });

  it("excludes unpublished pages even when the name matches", () => {
    const pages = [page({ title: "About", handle: "about", isPublished: false })];
    expect(titles(pages)).toEqual([]);
  });
});

describe("importShopifyPages", () => {
  const runPagesWithKb = (
    pages: ReadonlyArray<ShopPage>,
    kbSeed: ReadonlyArray<ReturnType<typeof toSeed>> = [],
    info: ShopInfo = shopInfo,
  ) =>
    Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const result = yield* importShopifyPages(tenantId);
          const kb = yield* KnowledgeBaseService;
          const docs = yield* kb.listFull(tenantId);
          return { result, docs };
        }),
        Layer.merge(
          ShopifyServiceTest({
            onlineStorePages: () => Effect.succeed(pages),
            shopInfo: info,
          }),
          KnowledgeBaseServiceTest(kbSeed),
        ),
      ),
    );

  it("creates url docs at the page's public storefront URL", async () => {
    const { result, docs } = await runPagesWithKb([
      page(),
      page({ title: "About Us", handle: "about-us", body: "<p>Since 2019.</p>" }),
    ]);
    expect(result).toEqual({ created: 2, updated: 0, skipped: 0 });
    expect(docs).toHaveLength(2);
    const faq = docs.find(
      (d) => d.sourceUrl === "https://shop.example/pages/faq",
    );
    expect(faq?.sourceType).toBe("url");
    expect(faq?.content).toContain("How long is shipping? 3 days.");
    expect(faq?.content).not.toContain("<p>");
    expect(
      docs.some((d) => d.sourceUrl === "https://shop.example/pages/about-us"),
    ).toBe(true);
  });

  it("imports nothing when no page passes the heuristic", async () => {
    const { result, docs } = await runPagesWithKb([
      page({ title: "Wholesale pricing", handle: "wholesale-pricing" }),
    ]);
    expect(result).toEqual({ created: 0, updated: 0, skipped: 0 });
    expect(docs).toHaveLength(0);
  });

  it("skips a matching page whose body is empty", async () => {
    const { result, docs } = await runPagesWithKb([page({ body: "<p></p>" })]);
    expect(result).toEqual({ created: 0, updated: 0, skipped: 1 });
    expect(docs).toHaveLength(0);
  });

  it("dedups by url: unchanged content skips, changed content updates", async () => {
    const first = await runPagesWithKb([page()]);
    expect(first.result.created).toBe(1);

    const unchanged = await runPagesWithKb([page()], first.docs.map(toSeed));
    expect(unchanged.result).toEqual({ created: 0, updated: 0, skipped: 1 });

    const changed = await runPagesWithKb(
      [page({ body: "<p>Brand new answer.</p>" })],
      first.docs.map(toSeed),
    );
    expect(changed.result).toEqual({ created: 0, updated: 1, skipped: 0 });
    expect(changed.docs[0]!.content).toContain("Brand new answer.");
  });
});
