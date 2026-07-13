import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { TenantId } from "@support-agent/agent-core";
import {
  DATA_PROCESSING_NOTICE_VERSION,
  DPA_VERSION,
  TenantNotFound,
  TenantRepository,
  TenantRepositoryTest,
  TenantSettings,
  decodeResolutionPolicy,
  decodeResolutionPolicyUpdate,
  defaultBlockedSenders,
  defaultRefundPolicy,
  defaultDiscountPolicy,
  defaultResolutionPolicy,
  FACT_REFERENCE_CATALOG,
  resolveFactReferences,
  tokenizeActionReferences,
  type BlockedSenders,
  type LegalAcceptance,
  type RefundPolicy,
  type ResolutionPolicy,
} from "../src/index.js";

const tenantId = TenantId("00000000-0000-0000-0000-000000000001");

const currentLegalAcceptance: LegalAcceptance = {
  dataProcessingNoticeVersion: DATA_PROCESSING_NOTICE_VERSION,
  dpaVersion: DPA_VERSION,
  acceptedAt: "2026-06-04T12:00:00.000Z",
  acceptedByUserId: "11111111-1111-1111-1111-111111111111",
};

const settings = (
  overrides: Partial<ConstructorParameters<typeof TenantSettings>[0]> = {},
): TenantSettings =>
  new TenantSettings({
    notificationEmail: "ops@example.com",
    refundPolicy: defaultRefundPolicy,
    discountPolicy: defaultDiscountPolicy,
    retentionDays: 365,
    fulfillmentOperatorEscalationSheet: null,
    legalAcceptance: null,
    ...overrides,
  });

describe("TenantRepositoryTest", () => {
  it("uses a new data-processing notice version for the subprocessor-list change", () => {
    expect(DATA_PROCESSING_NOTICE_VERSION).toBe("2026-07-07");
  });

  it("returns the configured settings on getSettings", async () => {
    const initial = settings({ legalAcceptance: currentLegalAcceptance });
    const layer = TenantRepositoryTest({
      settingsByTenant: new Map([[tenantId, initial]]),
    });
    const got = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* TenantRepository;
          return yield* repo.getSettings(tenantId);
        }),
        layer,
      ),
    );
    expect(got.notificationEmail).toBe("ops@example.com");
    expect(got.refundPolicy.askAboveMinorUnits).toBe(0);
    expect(got.legalAcceptance).toEqual(currentLegalAcceptance);
  });

  it("fails with TenantNotFound when the tenant is absent", async () => {
    const layer = TenantRepositoryTest({});
    await expect(
      Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const repo = yield* TenantRepository;
            return yield* repo.getSettings(tenantId);
          }),
          layer,
        ),
      ),
    ).rejects.toBeInstanceOf(Error);
  });

  it("setRefundPolicy replaces the refundPolicy block (preserves notificationEmail)", async () => {
    const initial = settings({ legalAcceptance: currentLegalAcceptance });
    const layer = TenantRepositoryTest({
      settingsByTenant: new Map([[tenantId, initial]]),
    });
    const updatedPolicy: RefundPolicy = {
      askAboveMinorUnits: 2500,
      denyAboveMinorUnits: 20000,
      currencyCode: "EUR",
    };
    const got = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* TenantRepository;
          yield* repo.setRefundPolicy(tenantId, updatedPolicy);
          return yield* repo.getSettings(tenantId);
        }),
        layer,
      ),
    );
    expect(got.notificationEmail).toBe("ops@example.com");
    expect(got.refundPolicy).toEqual(updatedPolicy);
    expect(got.legalAcceptance).toEqual(currentLegalAcceptance);
  });

  it("setCancellationRestock replaces the flag (preserves refundPolicy)", async () => {
    const initial = settings({ cancellationRestock: true });
    const layer = TenantRepositoryTest({
      settingsByTenant: new Map([[tenantId, initial]]),
    });
    const got = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* TenantRepository;
          yield* repo.setCancellationRestock(tenantId, false);
          return yield* repo.getSettings(tenantId);
        }),
        layer,
      ),
    );
    expect(got.cancellationRestock).toBe(false);
    expect(got.refundPolicy).toEqual(defaultRefundPolicy);
    expect(got.notificationEmail).toBe("ops@example.com");
  });

  it("setRefundPolicy fails when the tenant is absent (TenantNotFound)", async () => {
    const layer = TenantRepositoryTest({});
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* TenantRepository;
          yield* repo.setRefundPolicy(tenantId, defaultRefundPolicy);
        }),
        layer,
      ),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const err = (exit.cause as { error?: unknown }).error;
      expect(err).toBeInstanceOf(TenantNotFound);
    }
  });

  it("setFulfillmentOperatorEscalationSheet stores the sheet target (preserves siblings)", async () => {
    const initial = settings({ legalAcceptance: currentLegalAcceptance });
    const layer = TenantRepositoryTest({
      settingsByTenant: new Map([[tenantId, initial]]),
    });
    const got = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* TenantRepository;
          yield* repo.setFulfillmentOperatorEscalationSheet(tenantId, {
            spreadsheetId: "abc123",
            range: "Escalations!A:F",
            description: "warehouse ops",
          });
          return yield* repo.getSettings(tenantId);
        }),
        layer,
      ),
    );
    expect(got.notificationEmail).toBe("ops@example.com");
    expect(got.refundPolicy).toEqual(defaultRefundPolicy);
    expect(got.legalAcceptance).toEqual(currentLegalAcceptance);
    expect(got.fulfillmentOperatorEscalationSheet).toEqual({
      spreadsheetId: "abc123",
      range: "Escalations!A:F",
      description: "warehouse ops",
    });
  });

  it("setFulfillmentOperatorEscalationSheet clears the sheet when passed null", async () => {
    const initial = settings({
      fulfillmentOperatorEscalationSheet: {
        spreadsheetId: "abc123",
        range: "Escalations!A:F",
        description: null,
      },
    });
    const layer = TenantRepositoryTest({
      settingsByTenant: new Map([[tenantId, initial]]),
    });
    const got = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* TenantRepository;
          yield* repo.setFulfillmentOperatorEscalationSheet(tenantId, null);
          return yield* repo.getSettings(tenantId);
        }),
        layer,
      ),
    );
    expect(got.fulfillmentOperatorEscalationSheet).toBeNull();
  });

  it("setFulfillmentOperatorEscalationSheet fails when the tenant is absent (TenantNotFound)", async () => {
    const layer = TenantRepositoryTest({});
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* TenantRepository;
          yield* repo.setFulfillmentOperatorEscalationSheet(tenantId, null);
        }),
        layer,
      ),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const err = (exit.cause as { error?: unknown }).error;
      expect(err).toBeInstanceOf(TenantNotFound);
    }
  });

  it("setLegalAcceptance records the current notice/DPA acceptance (preserves siblings)", async () => {
    const initial = settings();
    const layer = TenantRepositoryTest({
      settingsByTenant: new Map([[tenantId, initial]]),
    });
    const got = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* TenantRepository;
          yield* repo.setLegalAcceptance(tenantId, currentLegalAcceptance);
          return yield* repo.getSettings(tenantId);
        }),
        layer,
      ),
    );
    expect(got.notificationEmail).toBe("ops@example.com");
    expect(got.refundPolicy).toEqual(defaultRefundPolicy);
    expect(got.legalAcceptance).toEqual(currentLegalAcceptance);
  });

  it("setLegalAcceptance fails when the tenant is absent (TenantNotFound)", async () => {
    const layer = TenantRepositoryTest({});
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* TenantRepository;
          yield* repo.setLegalAcceptance(tenantId, currentLegalAcceptance);
        }),
        layer,
      ),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const err = (exit.cause as { error?: unknown }).error;
      expect(err).toBeInstanceOf(TenantNotFound);
    }
  });

  it("setRephraseModel stores the model (preserves siblings)", async () => {
    const initial = settings({ legalAcceptance: currentLegalAcceptance });
    const layer = TenantRepositoryTest({
      settingsByTenant: new Map([[tenantId, initial]]),
    });
    const got = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* TenantRepository;
          yield* repo.setRephraseModel(tenantId, "anthropic/claude-haiku-4-5");
          return yield* repo.getSettings(tenantId);
        }),
        layer,
      ),
    );
    expect(got.notificationEmail).toBe("ops@example.com");
    expect(got.refundPolicy).toEqual(defaultRefundPolicy);
    expect(got.legalAcceptance).toEqual(currentLegalAcceptance);
    expect(got.rephraseModel).toBe("anthropic/claude-haiku-4-5");
  });

  it("setRephraseModel clears the model when passed null", async () => {
    const initial = settings({ rephraseModel: "openai/gpt-4o-mini" });
    const layer = TenantRepositoryTest({
      settingsByTenant: new Map([[tenantId, initial]]),
    });
    const got = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* TenantRepository;
          yield* repo.setRephraseModel(tenantId, null);
          return yield* repo.getSettings(tenantId);
        }),
        layer,
      ),
    );
    expect(got.rephraseModel).toBeNull();
  });

  it("setRephraseModel fails when the tenant is absent (TenantNotFound)", async () => {
    const layer = TenantRepositoryTest({});
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* TenantRepository;
          yield* repo.setRephraseModel(tenantId, "x");
        }),
        layer,
      ),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const err = (exit.cause as { error?: unknown }).error;
      expect(err).toBeInstanceOf(TenantNotFound);
    }
  });

  it("setResolutionPolicy round-trips and preserves siblings", async () => {
    const initial = settings({ legalAcceptance: currentLegalAcceptance });
    const layer = TenantRepositoryTest({
      settingsByTenant: new Map([[tenantId, initial]]),
    });
    const custom: ResolutionPolicy = {
      scenarios: [
        {
          key: "vip_complaint",
          label: "VIP complaint",
          builtin: false,
          enabledActions: [{ tool: "refund.create", permission: "ask" }],
          fulfillmentOperatorMode: "none",
        },
      ],
    };
    const got = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* TenantRepository;
          yield* repo.setResolutionPolicy(tenantId, custom);
          return yield* repo.getSettings(tenantId);
        }),
        layer,
      ),
    );
    expect(got.resolutionPolicy).toEqual(custom);
    expect(got.notificationEmail).toBe("ops@example.com");
    expect(got.legalAcceptance).toEqual(currentLegalAcceptance);
  });

  it("setBlockedSenders round-trips and preserves siblings", async () => {
    const initial = settings({ legalAcceptance: currentLegalAcceptance });
    const layer = TenantRepositoryTest({
      settingsByTenant: new Map([[tenantId, initial]]),
    });
    const blocked: BlockedSenders = {
      emails: ["spammer@gmail.com"],
      domains: ["marketing.example.com"],
    };
    const got = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* TenantRepository;
          yield* repo.setBlockedSenders(tenantId, blocked);
          return yield* repo.getSettings(tenantId);
        }),
        layer,
      ),
    );
    expect(got.blockedSenders).toEqual(blocked);
    expect(got.notificationEmail).toBe("ops@example.com");
    expect(got.legalAcceptance).toEqual(currentLegalAcceptance);
  });

  it("setBlockedSenders fails when the tenant is absent (TenantNotFound)", async () => {
    const layer = TenantRepositoryTest({});
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* TenantRepository;
          yield* repo.setBlockedSenders(tenantId, defaultBlockedSenders);
        }),
        layer,
      ),
    );
    expect(exit._tag).toBe("Failure");
  });
});

describe("playbook action references", () => {
  it("names every tool in the built-in notes as a `/` action ref, never as a bare id", () => {
    // The merchant reads a chip ("Issue a refund"); the model reads the tool id.
    // A bare id in a seeded note would leak the engineering name into the editor.
    for (const scenario of defaultResolutionPolicy.scenarios) {
      const notes = scenario.notes ?? "";
      expect(tokenizeActionReferences(notes)).toBe(notes);
    }
  });

  it("resolves the built-in notes back to the exact tool ids the agent calls", () => {
    const damaged = defaultResolutionPolicy.scenarios.find(
      (s) => s.key === "damaged_product",
    )!;
    const { resolved } = resolveFactReferences(damaged.notes ?? "", null);
    expect(resolved).toContain("conversation.ask_customer");
    expect(resolved).toContain("shopify.get_product");
    expect(resolved).toContain("refund.create");
    expect(resolved).not.toContain("/conversation.ask_customer");
    expect(resolved).not.toContain("/refund.create");
  });

  it("backfills a legacy stored note on read", () => {
    // Tenants who saved the Scenarios page before action refs existed carry a
    // frozen copy of the old prose, with bare tool ids in it. The read decoder
    // is the backfill: no migration, and it converges on the next save.
    const p = decodeResolutionPolicy({
      scenarios: [
        {
          key: "refund_request",
          label: "Refund request",
          builtin: true,
          fulfillmentOperatorMode: "none",
          enabledActions: [],
          notes: "When a refund is due, queue refund.create.",
        },
      ],
    });
    expect(p.scenarios[0]!.notes).toBe(
      "When a refund is due, queue /refund.create.",
    );
  });

  it("backfills a legacy stored note on save, so the row converges", () => {
    const p = decodeResolutionPolicyUpdate({
      scenarios: [
        {
          key: "",
          label: "VIP complaint",
          fulfillmentOperatorMode: "none",
          enabledActions: [],
          notes: "Escalate with fulfillment_operator.escalate first.",
        },
      ],
    });
    const custom = p.scenarios.find((s) => !s.builtin);
    expect(custom!.notes).toBe("Escalate with /fulfillment_operator.escalate first.");
  });
});

describe("decodeResolutionPolicy (defaults-on-read)", () => {
  it("returns the seeded built-ins when the value is absent", () => {
    const p = decodeResolutionPolicy(undefined);
    expect(p.scenarios.length).toBeGreaterThanOrEqual(5);
    expect(p.scenarios.every((s) => s.builtin)).toBe(true);
    expect(p.scenarios.map((s) => s.key)).toContain("refund_request");
  });

  it("falls back to defaults on malformed input", () => {
    expect(decodeResolutionPolicy(42)).toEqual(defaultResolutionPolicy);
    expect(decodeResolutionPolicy({ scenarios: "nope" })).toEqual(
      defaultResolutionPolicy,
    );
  });

  it("keeps a valid custom scenario", () => {
    const raw = {
      scenarios: [
        {
          key: "vip_complaint",
          label: "VIP complaint",
          recognition: "An angry high-value customer",
          builtin: false,
          enabledActions: [{ tool: "refund.create", permission: "ask" }],
          fulfillmentOperatorMode: "none",
          notes: "Be extra gracious.",
        },
      ],
    };
    const p = decodeResolutionPolicy(raw);
    expect(p.scenarios).toHaveLength(1);
    expect(p.scenarios[0]!.key).toBe("vip_complaint");
    expect(p.scenarios[0]!.enabledActions[0]).toEqual({
      tool: "refund.create",
      permission: "ask",
    });
    expect(p.scenarios[0]!.fulfillmentOperatorMode).toBe("none");
    expect(p.scenarios[0]!.notes).toBe("Be extra gracious.");
    // No `enabled` in the raw → defaults to enabled (back-compat).
    expect(p.scenarios[0]!.enabled).toBe(true);
  });

  it("respects an explicit enabled:false and defaults absent enabled to true", () => {
    const raw = {
      scenarios: [
        {
          key: "off_one",
          label: "Off",
          builtin: false,
          enabled: false,
          enabledActions: [],
          fulfillmentOperatorMode: "none",
        },
        {
          key: "on_one",
          label: "On",
          builtin: false,
          enabledActions: [],
          fulfillmentOperatorMode: "none",
        },
      ],
    };
    const p = decodeResolutionPolicy(raw);
    expect(p.scenarios.find((s) => s.key === "off_one")!.enabled).toBe(false);
    expect(p.scenarios.find((s) => s.key === "on_one")!.enabled).toBe(true);
  });

  it("falls back to defaults when no scenario is valid (bad fulfillmentOperatorMode / empty key)", () => {
    const raw = {
      scenarios: [
        {
          key: "bad",
          label: "Bad",
          builtin: false,
          enabledActions: [],
          fulfillmentOperatorMode: "whenever", // invalid fulfillmentOperatorMode → scenario dropped
        },
        {
          key: "", // empty key → scenario dropped
          label: "Empty key",
          builtin: false,
          enabledActions: [],
          fulfillmentOperatorMode: "none",
        },
      ],
    };
    expect(decodeResolutionPolicy(raw)).toEqual(defaultResolutionPolicy);
  });

  it("drops invalid actions but keeps the otherwise-valid scenario", () => {
    const raw = {
      scenarios: [
        {
          key: "mix",
          label: "Mix",
          builtin: false,
          enabledActions: [
            { tool: "refund.create", permission: "ask" },
            { tool: 5, permission: "allow" },
          ],
          fulfillmentOperatorMode: "none",
        },
      ],
    };
    const p = decodeResolutionPolicy(raw);
    expect(p.scenarios).toHaveLength(1);
    expect(p.scenarios[0]!.enabledActions).toEqual([
      { tool: "refund.create", permission: "ask" },
    ]);
  });
});

describe("delivery_issue built-in scenario", () => {
  const di = defaultResolutionPolicy.scenarios.find(
    (s) => s.key === "delivery_issue",
  );

  it("escalates to the fulfillment operator and reassures the customer in the same run", () => {
    expect(di).toBeDefined();
    expect(di!.fulfillmentOperatorMode).toBe("escalate_and_wait");
    const notes = (di!.notes ?? "").toLowerCase();
    expect(notes).toContain("fulfillment operator");
    expect(notes).toContain("reassur");
  });
});

describe("damaged_product built-in scenario", () => {
  const dp = defaultResolutionPolicy.scenarios.find(
    (s) => s.key === "damaged_product",
  );

  it("asks for photos, verifies them against the product, and flags a mismatch to the merchant", () => {
    expect(dp).toBeDefined();
    expect(dp!.fulfillmentOperatorMode).toBe("escalate_and_wait");
    const notes = (dp!.notes ?? "").toLowerCase();
    // Ask for evidence when none was attached.
    expect(notes).toContain("photo");
    expect(notes).toContain("ask");
    // Compare the photos against the ordered product.
    expect(notes).toContain("product");
    // A mismatch is flagged to the merchant, not used to deny the customer.
    expect(notes).toContain("mismatch");
    expect(notes).toContain("merchant");
    expect(notes).toContain("unitprice");
    expect(notes).toContain("partial refund");
  });
});

describe("wrong_item built-in scenario", () => {
  const wi = defaultResolutionPolicy.scenarios.find(
    (s) => s.key === "wrong_item",
  );

  it("ships as a fulfillment-operator built-in with a gated refund", () => {
    expect(wi).toBeDefined();
    expect(wi!.builtin).toBe(true);
    expect(wi!.enabled).toBe(true);
    expect(wi!.fulfillmentOperatorMode).toBe("escalate_and_wait");
    expect(wi!.enabledActions).toEqual([
      { tool: "refund.create", permission: "ask" },
    ]);
  });

  it("asks for a photo, verifies it, prefers a reship, and flags uncertainty", () => {
    const notes = (wi!.notes ?? "").toLowerCase();
    expect(notes).toContain("photo");
    expect(notes).toContain("product");
    expect(notes).toContain("fulfillment operator");
    expect(notes).toContain("merchant");
    expect(notes).toContain("reassur");
    // Refund is the fallback, not the first move.
    expect(notes).toContain("refund only");
    expect(notes).toContain("unitprice");
    expect(notes).toContain("partial refund");
  });

  it("survives the write-path normalizer as a forced built-in", () => {
    const p = decodeResolutionPolicyUpdate({ scenarios: [] });
    const out = p.scenarios.find((s) => s.key === "wrong_item");
    expect(out).toBeDefined();
    expect(out!.builtin).toBe(true);
  });
});

describe("built-in scenario notes reference store facts", () => {
  const byKey = (k: string) =>
    defaultResolutionPolicy.scenarios.find((s) => s.key === k)!;

  it("where_is_order quotes the store's own processing + delivery times", () => {
    // The most common ticket there is: "when will it arrive?". The two numbers
    // that answer it are stated Facts, so the note points at them rather than
    // sending the agent hunting through prose.
    const notes = byKey("where_is_order").notes ?? "";
    expect(notes).toContain("@shipping.processing_time");
    expect(notes).toContain("@shipping.delivery_time");
  });

  it("keeps the literal where-is-my-order wording mapped to the where_is_order scenario", () => {
    const scenario = byKey("where_is_order");
    expect(scenario.label).toBe("Where is my order?");
    expect(scenario.recognition?.toLowerCase()).toContain(
      "where their order is",
    );
  });

  it("delivery_issue judges lateness by the stated delayed-after threshold", () => {
    const notes = byKey("delivery_issue").notes ?? "";
    expect(notes).toContain("@shipping.delayed_after");
    expect(notes).toContain("@shipping.lost_after");
    // The elapsed number comes from 17track's transitDays, never a hand count.
    expect(notes).toContain("transitDays");
    expect(notes.toLowerCase()).toContain("do not count the days yourself");
    // The safety property the Facts must not erode: with no stated window the
    // agent may not assert the order is on schedule.
    expect(notes.toLowerCase()).toContain("cannot confirm lateness");
  });

  it("refund_request references the window, the payer, the method, and the timing", () => {
    // Everything a customer asking for their money back needs told to them.
    const notes = byKey("refund_request").notes ?? "";
    expect(notes).toContain("@returns.return_window");
    expect(notes).toContain("@returns.return_shipping");
    expect(notes).toContain("@returns.refund_method");
    expect(notes).toContain("@returns.refund_processing_time");
  });

  it("refund_request can offer one line item's amount on multi-item orders", () => {
    const notes = byKey("refund_request").notes ?? "";
    expect(notes).toContain("lineItems");
    expect(notes).toContain("unitPrice");
    expect(notes.toLowerCase()).toContain("one line item");
    expect(notes.toLowerCase()).toContain("partial refund");
    expect(notes).toContain("refund.create");
  });

  it("wrong_item quotes the refund processing time via a fact reference", () => {
    expect(byKey("wrong_item").notes ?? "").toContain(
      "@returns.refund_processing_time",
    );
  });

  it("damaged_product quotes the refund processing time when it refunds", () => {
    expect(byKey("damaged_product").notes ?? "").toContain(
      "@returns.refund_processing_time",
    );
  });

  it("order_cancellation references the return window and the refund timing", () => {
    const notes = byKey("order_cancellation").notes ?? "";
    expect(notes).toContain("@returns.return_window");
    expect(notes).toContain("@returns.refund_processing_time");
  });

  it("shipping_address_update references the processing time it races against", () => {
    // The address is editable only until the order leaves the warehouse, and
    // the processing time is exactly how long that is.
    expect(byKey("shipping_address_update").notes ?? "").toContain(
      "@shipping.processing_time",
    );
  });

  it("general_inquiry answers the common shipping + returns questions from Facts", () => {
    // A general question is most often "how long does shipping take" / "what's
    // your return policy". Field refs, NOT the `@shipping` / `@returns`
    // whole-block summaries: those join their fragments unlabeled ("1–2 business
    // days; 7–12 days; …"), so the model can't tell which number is which.
    const notes = byKey("general_inquiry").notes ?? "";
    expect(notes).toContain("@shipping.processing_time");
    expect(notes).toContain("@shipping.delivery_time");
    expect(notes).toContain("@returns.return_window");
  });

  it("every fact reference in a built-in note is a real catalog id", () => {
    // Guard against a typo'd @-ref shipping in a default note: it would show as
    // a dangling fallback to every unconfigured tenant.
    const ids = new Set(FACT_REFERENCE_CATALOG.map((e) => e.id));
    const tokenRe = /@([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)?)/g;
    for (const s of defaultResolutionPolicy.scenarios) {
      for (const m of (s.notes ?? "").matchAll(tokenRe)) {
        expect(ids.has(m[1]!)).toBe(true);
      }
    }
  });

  it("resolves every built-in note to real values once both Facts blocks are filled", () => {
    // The end state the defaults are written for: a merchant who filled both
    // forms gets prose carrying THEIR numbers, with nothing dangling and no raw
    // token left behind for the model to read as literal text.
    const settings = new TenantSettings({
      notificationEmail: null,
      refundPolicy: defaultRefundPolicy,
      discountPolicy: defaultDiscountPolicy,
      retentionDays: 365,
      fulfillmentOperatorEscalationSheet: null,
      legalAcceptance: null,
      shippingFacts: {
        processingTime: "1–2 business days",
        deliveryTime: "7–12 days",
        shippingCost: "Free over $50",
        customsDuties: "customer",
        delayedAfterDays: 14,
        lostPackageInvestigationDays: 30,
      },
      returnsFacts: {
        returnWindowDays: 30,
        returnShippingPayer: "customer",
        refundMethod: "original",
        refundProcessingTime: "5–7 business days",
      },
    });

    for (const s of defaultResolutionPolicy.scenarios) {
      const { resolved, dangling } = resolveFactReferences(
        s.notes ?? "",
        settings,
      );
      expect(dangling, `${s.key} has dangling refs`).toEqual([]);
      expect(resolved, `${s.key} left a raw token`).not.toMatch(
        /@(shipping|returns|refunds)\b/,
      );
    }
  });

  it("degrades every built-in note to a neutral phrase when no Facts are set", () => {
    // The unconfigured tenant — the default state on day 1. Each ref falls back
    // to a neutral phrase, so the playbook still reads as English and never
    // shows the merchant's customer a raw `@shipping.delivery_time`.
    for (const s of defaultResolutionPolicy.scenarios) {
      const { resolved } = resolveFactReferences(s.notes ?? "", null);
      expect(resolved, `${s.key} left a raw token`).not.toMatch(
        /@(shipping|returns|refunds)\b/,
      );
    }
  });
});

describe("order_cancellation built-in scenario", () => {
  const cancel = defaultResolutionPolicy.scenarios.find(
    (s) => s.key === "order_cancellation",
  );

  it("ships as a built-in with order.cancel gated by approval", () => {
    expect(cancel).toBeDefined();
    expect(cancel!.builtin).toBe(true);
    expect(cancel!.enabled).toBe(true);
    expect(cancel!.fulfillmentOperatorMode).toBe("none");
    expect(cancel!.enabledActions).toEqual([
      { tool: "order.cancel", permission: "ask" },
    ]);
  });

  it("survives the write-path normalizer as a forced built-in", () => {
    // A merchant can't delete it or strip its remedy by omission; the write
    // decoder re-seeds every built-in.
    const p = decodeResolutionPolicyUpdate({ scenarios: [] });
    const out = p.scenarios.find((s) => s.key === "order_cancellation");
    expect(out).toBeDefined();
    expect(out!.builtin).toBe(true);
  });
});

describe("shipping_address_update built-in scenario", () => {
  const ship = defaultResolutionPolicy.scenarios.find(
    (s) => s.key === "shipping_address_update",
  );

  it("ships as a built-in with the address edit gated by approval", () => {
    expect(ship).toBeDefined();
    expect(ship!.builtin).toBe(true);
    expect(ship!.enabled).toBe(true);
    expect(ship!.enabledActions).toEqual([
      { tool: "order.update_shipping_address", permission: "ask" },
    ]);
  });

  it("escalates to the fulfillment operator and waits after shipment", () => {
    // The unfulfilled branch edits the order; the fulfilled branch can't —
    // the parcel is moving — so the playbook hands it to the fulfillment operator.
    expect(ship!.fulfillmentOperatorMode).toBe("escalate_and_wait");
    const notes = (ship!.notes ?? "").toLowerCase();
    expect(notes).toContain("ask");
    expect(notes).toContain("fulfillment operator");
  });

  it("survives the write-path normalizer as a forced built-in", () => {
    const p = decodeResolutionPolicyUpdate({ scenarios: [] });
    const out = p.scenarios.find((s) => s.key === "shipping_address_update");
    expect(out).toBeDefined();
    expect(out!.builtin).toBe(true);
  });
});

describe("decodeResolutionPolicyUpdate (write-path normalizer)", () => {
  const builtinKeys = defaultResolutionPolicy.scenarios.map((s) => s.key);

  it("always keeps every built-in present, even when the body omits them", () => {
    const p = decodeResolutionPolicyUpdate({ scenarios: [] });
    expect(p.scenarios.map((s) => s.key)).toEqual(builtinKeys);
    expect(p.scenarios.every((s) => s.builtin)).toBe(true);
  });

  it("forces built-in immutable fields (key/label/recognition/builtin) from defaults", () => {
    const def = defaultResolutionPolicy.scenarios[0]!;
    const p = decodeResolutionPolicyUpdate({
      scenarios: [
        {
          // A merchant tries to rename a built-in + flip its builtin flag.
          key: def.key,
          label: "Hacked label",
          recognition: "Hacked recognition",
          builtin: false,
          enabled: false,
          enabledActions: [{ tool: "refund.create", permission: "allow" }],
          fulfillmentOperatorMode: "notify_and_proceed",
          notes: "merchant note",
        },
      ],
    });
    const out = p.scenarios.find((s) => s.key === def.key)!;
    // Immutable fields are restored from the seeded defaults …
    expect(out.label).toBe(def.label);
    expect(out.recognition).toBe(def.recognition);
    expect(out.builtin).toBe(true);
    // … while the editable fields are taken from the body.
    expect(out.enabled).toBe(false);
    expect(out.enabledActions).toEqual([
      { tool: "refund.create", permission: "allow" },
    ]);
    expect(out.fulfillmentOperatorMode).toBe("notify_and_proceed");
    expect(out.notes).toBe("merchant note");
  });

  it("accepts a custom scenario, forcing builtin:false and namespacing its key", () => {
    const p = decodeResolutionPolicyUpdate({
      scenarios: [
        {
          key: "VIP Complaint!", // unsanitized
          label: "VIP complaint",
          recognition: "An angry high-value customer",
          builtin: true, // lie — must be coerced to false
          enabled: true,
          enabledActions: [{ tool: "discount.create", permission: "ask" }],
          fulfillmentOperatorMode: "none",
          notes: "Be gracious.",
        },
      ],
    });
    const custom = p.scenarios.find((s) => !s.builtin)!;
    expect(custom.builtin).toBe(false);
    expect(custom.key).toBe("custom_vip_complaint");
    expect(custom.label).toBe("VIP complaint");
    expect(custom.recognition).toBe("An angry high-value customer");
    expect(custom.enabledActions).toEqual([
      { tool: "discount.create", permission: "ask" },
    ]);
    // Built-ins still come along.
    expect(p.scenarios.filter((s) => s.builtin).map((s) => s.key)).toEqual(
      builtinKeys,
    );
  });

  it("derives a custom key from the label when none is supplied", () => {
    const p = decodeResolutionPolicyUpdate({
      scenarios: [
        {
          key: "",
          label: "Wholesale order question",
          recognition: "B2B / bulk buyer asking about an order",
          builtin: false,
          enabledActions: [],
          fulfillmentOperatorMode: "none",
        },
      ],
    });
    expect(p.scenarios.find((s) => !s.builtin)!.key).toBe(
      "custom_wholesale_order_question",
    );
  });

  it("dedupes colliding custom keys and never clobbers a built-in", () => {
    const p = decodeResolutionPolicyUpdate({
      scenarios: [
        {
          key: "",
          label: "Returns",
          builtin: false,
          enabledActions: [],
          fulfillmentOperatorMode: "none",
        },
        {
          key: "",
          label: "Returns",
          builtin: false,
          enabledActions: [],
          fulfillmentOperatorMode: "none",
        },
        {
          // Tries to masquerade as a built-in via a custom_ key.
          key: "custom_where_is_order",
          label: "Sneaky",
          builtin: false,
          enabledActions: [],
          fulfillmentOperatorMode: "none",
        },
      ],
    });
    const customKeys = p.scenarios.filter((s) => !s.builtin).map((s) => s.key);
    expect(customKeys).toEqual([
      "custom_returns",
      "custom_returns_2",
      "custom_where_is_order",
    ]);
    // The real built-in is untouched + distinct.
    expect(p.scenarios.find((s) => s.key === "where_is_order")!.builtin).toBe(
      true,
    );
  });

  it("keeps a stable existing custom key across an edit (no re-slug from label)", () => {
    const p = decodeResolutionPolicyUpdate({
      scenarios: [
        {
          key: "custom_vip_complaint", // already-assigned key round-tripped
          label: "VIP escalation", // renamed
          recognition: "angry whale",
          builtin: false,
          enabledActions: [],
          fulfillmentOperatorMode: "none",
        },
      ],
    });
    expect(p.scenarios.find((s) => !s.builtin)!.key).toBe("custom_vip_complaint");
  });

  it("drops a custom scenario with a blank label", () => {
    const p = decodeResolutionPolicyUpdate({
      scenarios: [
        {
          key: "",
          label: "   ",
          builtin: false,
          enabledActions: [],
          fulfillmentOperatorMode: "none",
        },
      ],
    });
    expect(p.scenarios.every((s) => s.builtin)).toBe(true);
  });

  it("defaults a custom's invalid fulfillmentOperatorMode to none and drops invalid actions", () => {
    const p = decodeResolutionPolicyUpdate({
      scenarios: [
        {
          key: "",
          label: "Odd one",
          builtin: false,
          enabledActions: [
            { tool: "refund.create", permission: "ask" },
            { tool: 7, permission: "allow" },
          ],
          fulfillmentOperatorMode: "whenever",
        },
      ],
    });
    const custom = p.scenarios.find((s) => !s.builtin)!;
    expect(custom.fulfillmentOperatorMode).toBe("none");
    expect(custom.enabledActions).toEqual([
      { tool: "refund.create", permission: "ask" },
    ]);
  });

  it("falls back to all built-ins on a wholly malformed body", () => {
    expect(decodeResolutionPolicyUpdate(42).scenarios.map((s) => s.key)).toEqual(
      builtinKeys,
    );
    expect(
      decodeResolutionPolicyUpdate({ scenarios: "nope" }).scenarios.every(
        (s) => s.builtin,
      ),
    ).toBe(true);
  });
});
