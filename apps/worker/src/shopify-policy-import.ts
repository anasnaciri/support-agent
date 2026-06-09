// ============================================================
// Shopify shop-policy → knowledge-base import
// ============================================================
//
// After a tenant connects their Shopify store we seed their knowledge base
// with the store's own shipping + refund policies, so specialists ground
// answers in the merchant's real policy text instead of guessing. Best-effort:
// a store with no policies, a missing `read_legal_policies` scope, or any
// transient Shopify error must never break the connect flow — `runShopifyPolicyImport`
// swallows everything (see the silent boundary at the bottom).
//
// Storage model (decided with the user): each policy is stored as a `url`
// knowledge doc keyed by the policy's public storefront URL. That gives a
// natural dedup key (re-running compares `contentHash` and no-ops / updates)
// and a working "Resync" button in the dashboard. Shopify has no separate
// return policy — returns live under REFUND_POLICY — so importing shipping +
// refund covers "shipping + refund + return".

import { createHash } from "node:crypto";
import { Effect } from "effect";
import type {
  ConnectorStoreDbError,
  ShopifyError,
  TenantId,
} from "@support-agent/agent-core";
import { htmlToText } from "@support-agent/providers";
import { KnowledgeBaseService, ShopifyService } from "@support-agent/services";

/**
 * Policy types we pull into the knowledge base. Refund covers returns; the
 * rest of Shopify's `ShopPolicyType` values (privacy, terms, …) aren't useful
 * support grounding and would just add noise.
 */
const IMPORTED_POLICY_TYPES: ReadonlySet<string> = new Set([
  "SHIPPING_POLICY",
  "REFUND_POLICY",
]);

/** Friendly titles when the store hasn't named the policy itself. */
const DEFAULT_TITLES: Readonly<Record<string, string>> = {
  SHIPPING_POLICY: "Shipping policy",
  REFUND_POLICY: "Refund & return policy",
};

// Mirror the dashboard's create caps so an auto-imported doc looks like any
// hand-added one (apps/api KB_MAX_TITLE_CHARS / KB_MAX_CONTENT_CHARS).
const TITLE_MAX_CHARS = 200;
const CONTENT_MAX_CHARS = 100_000;

const sha256 = (s: string): string =>
  createHash("sha256").update(s, "utf8").digest("hex");

export interface PolicyImportResult {
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
}

/**
 * Core import. Surfaces errors (Shopify fetch / KB write) so callers can decide
 * how to handle them — the silent boundary is `runShopifyPolicyImport`. Idempotent:
 * a policy already stored at the same URL with the same content is left alone.
 */
export const importShopifyPolicies = (
  tenantId: TenantId,
): Effect.Effect<
  PolicyImportResult,
  ShopifyError | ConnectorStoreDbError,
  ShopifyService | KnowledgeBaseService
> =>
  Effect.gen(function* () {
    const shopify = yield* ShopifyService;
    const kb = yield* KnowledgeBaseService;

    const policies = yield* shopify.getShopPolicies(tenantId);
    const relevant = policies.filter((p) => IMPORTED_POLICY_TYPES.has(p.type));
    if (relevant.length === 0) {
      return { created: 0, updated: 0, skipped: 0 };
    }

    // Index existing url-sourced docs by their source URL so we dedup against
    // both prior imports AND any policy the merchant added by hand.
    const existing = yield* kb.listFull(tenantId);
    const byUrl = new Map<string, (typeof existing)[number]>();
    for (const d of existing) {
      if (d.sourceType === "url" && d.sourceUrl) byUrl.set(d.sourceUrl, d);
    }

    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const p of relevant) {
      const content = htmlToText(p.body).slice(0, CONTENT_MAX_CHARS);
      // A configured-but-empty policy (or one with no public URL) carries
      // nothing for the agents — don't store an empty doc.
      if (content.length === 0 || p.url.length === 0) {
        skipped++;
        continue;
      }
      const title = (
        p.title.trim() ||
        DEFAULT_TITLES[p.type] ||
        "Store policy"
      ).slice(0, TITLE_MAX_CHARS);
      const contentHash = sha256(content);
      const prior = byUrl.get(p.url);

      if (!prior) {
        yield* kb.create(tenantId, {
          title,
          content,
          sourceType: "url",
          sourceUrl: p.url,
          contentHash,
          fetchedAt: new Date(),
        });
        created++;
      } else if (prior.contentHash !== contentHash) {
        yield* kb.update(tenantId, prior.id, {
          title,
          content,
          contentHash,
          fetchedAt: new Date(),
        });
        updated++;
      } else {
        skipped++;
      }
    }

    return { created, updated, skipped };
  });

/**
 * Best-effort wrapper used by the worker consumer. Logs the outcome and
 * swallows every failure — policy import is a nice-to-have that must never
 * surface as a job failure or block anything upstream. Returns void, never fails.
 */
export const runShopifyPolicyImport = (
  tenantId: TenantId,
): Effect.Effect<void, never, ShopifyService | KnowledgeBaseService> =>
  importShopifyPolicies(tenantId).pipe(
    Effect.tap((r) =>
      Effect.sync(() => {
        // eslint-disable-next-line no-console
        console.log(
          `[shopify-policy-import] tenant=${tenantId} created=${r.created} updated=${r.updated} skipped=${r.skipped}`,
        );
      }),
    ),
    Effect.catchAll((cause) =>
      Effect.sync(() => {
        const detail =
          cause instanceof Error ? cause.message : String(cause);
        // eslint-disable-next-line no-console
        console.warn(
          `[shopify-policy-import] tenant=${tenantId} skipped (best-effort): ${detail}`,
        );
      }),
    ),
    Effect.asVoid,
  );
