import { afterAll, describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { TenantId } from "@support-agent/agent-core";
import {
  TenantRepository,
  advanceOnboardingState,
  freshOnboardingState,
  onboardingPending,
} from "@support-agent/services";
import {
  DbClientLive,
  createTenantForOrg,
  createWorkspaceForOrg,
  makeDbClient,
  TenantRepositoryLive,
  tenants,
} from "../src/index.js";

// The gate the whole wizard hangs off: a NEW workspace is stamped pending at
// creation, an OLD one (no `onboarding` key in settings) is never pending, and
// the state survives a JSONB round-trip without disturbing sibling settings.
const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

const legalAcceptance = {
  acceptedAt: "2026-07-14T10:00:00.000Z",
  dataProcessingNoticeVersion: "2025-01-01",
  dpaVersion: "2025-01-01",
  acceptedByUserId: "user_test",
};

describeIfDb("onboarding state (live)", () => {
  const client = makeDbClient({ databaseUrl: databaseUrl! });
  const { db } = client;
  const seeded: string[] = [];

  afterAll(async () => {
    if (seeded.length > 0) {
      await db.delete(tenants).where(inArray(tenants.id, seeded));
    }
    await client.close();
  });

  const layer = TenantRepositoryLive.pipe(
    Layer.provide(DbClientLive({ databaseUrl: databaseUrl! })),
  );

  const run = <A>(eff: Effect.Effect<A, unknown, TenantRepository>) =>
    Effect.runPromise(
      Effect.provide(eff as Effect.Effect<A, never, TenantRepository>, layer),
    );

  const readSettings = (tenantId: TenantId) =>
    run(
      Effect.gen(function* () {
        const repo = yield* TenantRepository;
        return yield* repo.getSettings(tenantId);
      }),
    );

  const seedLegacyTenant = async (
    settings: Record<string, unknown>,
  ): Promise<TenantId> => {
    const id = randomUUID();
    await db.insert(tenants).values({ id, name: "Legacy Workspace", settings });
    seeded.push(id);
    return TenantId(id);
  };

  it("stamps a first workspace as pending onboarding", async () => {
    const organizationId = `org_${randomUUID()}`;
    const created = await createTenantForOrg(db, {
      organizationId,
      name: "Wizard Co",
      notificationEmail: "owner@example.com",
      legalAcceptance,
    });
    seeded.push(created.tenantId);

    const settings = await readSettings(TenantId(created.tenantId));
    expect(settings.onboarding).toEqual(freshOnboardingState());
    expect(onboardingPending(settings.onboarding ?? null)).toBe(true);
    // The stamp must not have displaced the settings written alongside it.
    expect(settings.notificationEmail).toBe("owner@example.com");
    expect(settings.legalAcceptance?.acceptedByUserId).toBe("user_test");
  });

  it("stamps an additional workspace as pending onboarding", async () => {
    const organizationId = `org_${randomUUID()}`;
    const { workspaceId } = await createWorkspaceForOrg(db, {
      organizationId,
      name: "Second Workspace",
      notificationEmail: "owner@example.com",
      legalAcceptance,
    });
    seeded.push(workspaceId);

    const settings = await readSettings(TenantId(workspaceId));
    expect(onboardingPending(settings.onboarding ?? null)).toBe(true);
  });

  it("leaves a pre-wizard workspace out of onboarding", async () => {
    // No `onboarding` key — exactly how every row created before this shipped
    // looks. It must never be gated into the wizard.
    const tenantId = await seedLegacyTenant({
      notificationEmail: "old@example.com",
    });
    const settings = await readSettings(tenantId);
    expect(settings.onboarding).toBeNull();
    expect(onboardingPending(settings.onboarding ?? null)).toBe(false);
  });

  it("round-trips an advanced state and preserves sibling settings", async () => {
    const tenantId = await seedLegacyTenant({
      notificationEmail: "keep@example.com",
      onboarding: freshOnboardingState(),
      returnsFacts: { returnWindowDays: 30 },
    });

    const advanced = advanceOnboardingState(freshOnboardingState(), {
      step: "store",
      status: "done",
      nextStep: "docs",
    });
    await run(
      Effect.gen(function* () {
        const repo = yield* TenantRepository;
        yield* repo.setOnboardingState(tenantId, advanced);
      }),
    );

    const settings = await readSettings(tenantId);
    expect(settings.onboarding?.steps).toEqual({ store: "done" });
    expect(settings.onboarding?.currentStep).toBe("docs");
    // The shallow JSONB merge must not have dropped unrelated settings.
    expect(settings.notificationEmail).toBe("keep@example.com");
    expect(settings.returnsFacts?.returnWindowDays).toBe(30);
  });

  it("stops being pending once completed", async () => {
    const tenantId = await seedLegacyTenant({
      onboarding: freshOnboardingState(),
    });
    await run(
      Effect.gen(function* () {
        const repo = yield* TenantRepository;
        yield* repo.setOnboardingState(tenantId, {
          ...freshOnboardingState(),
          completedAt: "2026-07-14T12:00:00.000Z",
        });
      }),
    );

    const settings = await readSettings(tenantId);
    expect(onboardingPending(settings.onboarding ?? null)).toBe(false);

    // And the raw column really carries it (not just the decoder's default).
    const rows = await db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    const raw = rows[0]?.settings as { onboarding?: { completedAt?: string } };
    expect(raw.onboarding?.completedAt).toBe("2026-07-14T12:00:00.000Z");
  });
});
