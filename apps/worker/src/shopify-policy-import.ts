// ============================================================
// Shopify shop-policy + store-page → knowledge-base import
// ============================================================
//
// After a tenant connects their Shopify store we seed their knowledge base
// with the store's own customer-facing text, so specialists ground answers
// in the merchant's real words instead of guessing. Two legs:
//   1. Shop policies (shipping + refund) — `shop.shopPolicies`.
//   2. Online Store pages — but ONLY About / Contact / FAQ, selected by a
//      deliberately conservative name heuristic. Under-importing is the
//      design: a "Wholesale pricing" page in the agent's grounding is worse
//      than a missing FAQ (the merchant can always add docs by hand).
// Both legs are best-effort: a store with nothing to import, a missing
// scope (`read_legal_policies` / `read_online_store_pages` — older installs
// won't have the page scope until re-OAuth), or any transient Shopify error
// must never break the connect flow — `runShopifyPolicyImport` swallows
// everything per leg (see the silent boundary at the bottom), so one leg
// failing never costs the other.
//
// Storage model (decided with the user): each item is stored as a `url`
// knowledge doc keyed by its public storefront URL (pages live at
// `<primary domain>/pages/<handle>`). That gives a natural dedup key
// (re-running compares `contentHash` and no-ops / updates) and a working
// "Resync" button in the dashboard.  Shopify has no separate return
// policy — returns live under REFUND_POLICY — so importing shipping +
// refund covers "shipping + refund + return".

import { createHash } from "node:crypto";
import { Effect } from "effect";
import type {
  ConnectorStoreDbError,
  ShopifyError,
  TenantId,
} from "@support-agent/agent-core";
import { htmlToText } from "@support-agent/providers";
import {
  KnowledgeBaseService,
  ShopifyService,
  type ShopPage,
} from "@support-agent/services";

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

/** One importable item, normalized: final title, raw HTML, public URL. */
interface UrlDocSource {
  readonly title: string;
  readonly html: string;
  readonly url: string;
}

/**
 * Shared upsert for both import legs. Indexes existing url-sourced docs by
 * their source URL so we dedup against both prior imports AND anything the
 * merchant added by hand at the same URL; compares `contentHash` to decide
 * create / update / skip. An item with an empty text body or no public URL
 * carries nothing for the agents and is skipped, never stored empty.
 */
const upsertUrlDocs = (
  tenantId: TenantId,
  items: ReadonlyArray<UrlDocSource>,
): Effect.Effect<
  PolicyImportResult,
  ConnectorStoreDbError,
  KnowledgeBaseService
> =>
  Effect.gen(function* () {
    const kb = yield* KnowledgeBaseService;

    const existing = yield* kb.listFull(tenantId);
    const byUrl = new Map<string, (typeof existing)[number]>();
    for (const d of existing) {
      if (d.sourceType === "url" && d.sourceUrl) byUrl.set(d.sourceUrl, d);
    }

    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const item of items) {
      const content = htmlToText(item.html).slice(0, CONTENT_MAX_CHARS);
      if (content.length === 0 || item.url.length === 0) {
        skipped++;
        continue;
      }
      const title = item.title.slice(0, TITLE_MAX_CHARS);
      const contentHash = sha256(content);
      const prior = byUrl.get(item.url);

      if (!prior) {
        yield* kb.create(tenantId, {
          title,
          content,
          sourceType: "url",
          sourceUrl: item.url,
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
 * Core policy import. Surfaces errors (Shopify fetch / KB write) so callers
 * can decide how to handle them — the silent boundary is
 * `runShopifyPolicyImport`. Idempotent: a policy already stored at the same
 * URL with the same content is left alone.
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

    const policies = yield* shopify.getShopPolicies(tenantId);
    const relevant = policies.filter((p) => IMPORTED_POLICY_TYPES.has(p.type));
    if (relevant.length === 0) {
      return { created: 0, updated: 0, skipped: 0 };
    }

    return yield* upsertUrlDocs(
      tenantId,
      relevant.map((p) => ({
        title: p.title.trim() || DEFAULT_TITLES[p.type] || "Store policy",
        html: p.body,
        url: p.url,
      })),
    );
  });

/**
 * Page names we import, compared after normalizing both the handle and the
 * title to bare lowercase alphanumerics ("About Us" / "about-us" / "F.A.Q."
 * all normalize cleanly). Exact membership only — "About our fulfillmentOperators"
 * does NOT match. Conservative by design (see the module header).
 */
const IMPORTED_PAGE_NAMES: ReadonlySet<string> = new Set([
  "about",
  "aboutus",
  "contact",
  "contactus",
  "faq",
  "faqs",
  "frequentlyaskedquestions",
]);

const normalizePageName = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The conservative About/Contact/FAQ selector: published pages whose handle
 * OR title normalizes to an allowed name. Pure — exported for unit tests.
 */
export const selectImportablePages = (
  pages: ReadonlyArray<ShopPage>,
): ReadonlyArray<ShopPage> =>
  pages.filter(
    (p) =>
      p.isPublished &&
      (IMPORTED_PAGE_NAMES.has(normalizePageName(p.handle)) ||
        IMPORTED_PAGE_NAMES.has(normalizePageName(p.title))),
  );

/**
 * Core page import (About / Contact / FAQ only). Same error surface and
 * idempotency as `importShopifyPolicies`. The public URL is constructed
 * from the shop's primary domain — Shopify's `Page` has no URL field —
 * so `getShopInfo` is only fetched when at least one page was selected.
 */
export const importShopifyPages = (
  tenantId: TenantId,
): Effect.Effect<
  PolicyImportResult,
  ShopifyError | ConnectorStoreDbError,
  ShopifyService | KnowledgeBaseService
> =>
  Effect.gen(function* () {
    const shopify = yield* ShopifyService;

    const pages = yield* shopify.getOnlineStorePages(tenantId);
    const selected = selectImportablePages(pages);
    if (selected.length === 0) {
      return { created: 0, updated: 0, skipped: 0 };
    }

    const info = yield* shopify.getShopInfo(tenantId);
    const base = info.primaryDomainUrl.replace(/\/+$/, "");

    return yield* upsertUrlDocs(
      tenantId,
      selected.map((p) => ({
        title: p.title.trim() || "Store page",
        html: p.body,
        url: `${base}/pages/${p.handle}`,
      })),
    );
  });

const logResult = (label: string, tenantId: TenantId, r: PolicyImportResult) =>
  Effect.sync(() => {
    // eslint-disable-next-line no-console
    console.log(
      `[${label}] tenant=${tenantId} created=${r.created} updated=${r.updated} skipped=${r.skipped}`,
    );
  });

const swallow = (label: string, tenantId: TenantId) => (cause: unknown) =>
  Effect.sync(() => {
    const detail = cause instanceof Error ? cause.message : String(cause);
    // eslint-disable-next-line no-console
    console.warn(
      `[${label}] tenant=${tenantId} skipped (best-effort): ${detail}`,
    );
  });

/**
 * Best-effort wrapper used by the worker consumer: policies first, then
 * pages, each leg logged and swallowed independently — the page leg failing
 * (e.g. `read_online_store_pages` not granted yet on an older install) must
 * not cost the policy import, and neither may surface as a job failure or
 * block anything upstream. Returns void, never fails.
 */
export const runShopifyPolicyImport = (
  tenantId: TenantId,
): Effect.Effect<void, never, ShopifyService | KnowledgeBaseService> =>
  Effect.zipRight(
    importShopifyPolicies(tenantId).pipe(
      Effect.tap((r) => logResult("shopify-policy-import", tenantId, r)),
      Effect.catchAll(swallow("shopify-policy-import", tenantId)),
    ),
    importShopifyPages(tenantId).pipe(
      Effect.tap((r) => logResult("shopify-page-import", tenantId, r)),
      Effect.catchAll(swallow("shopify-page-import", tenantId)),
    ),
  ).pipe(Effect.asVoid);
