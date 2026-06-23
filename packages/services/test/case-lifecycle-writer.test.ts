import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { AgentId, TenantId } from "@support-agent/agent-core";
import {
  AuditLogService,
  AuditLogServiceTest,
} from "../src/audit-log.js";
import {
  CaseRepository,
  CaseRepositoryTest,
} from "../src/case-repository.js";
import {
  CaseLifecycleWriter,
  CaseLifecycleWriterLive,
} from "../src/case-lifecycle-writer.js";
import { TransactionRunnerPassthrough } from "../src/transaction-runner.js";

const deps = Layer.mergeAll(
  CaseRepositoryTest,
  AuditLogServiceTest,
  TransactionRunnerPassthrough,
);

const layer = Layer.provideMerge(CaseLifecycleWriterLive, deps);

const run = <A, E>(
  eff: Effect.Effect<
    A,
    E,
    CaseRepository | AuditLogService | CaseLifecycleWriter
  >,
) => Effect.runPromise(Effect.provide(eff, layer));

describe("CaseLifecycleWriter", () => {
  it("escalates a waiting supplier case to human takeover with risk flag and audit", async () => {
    const out = await run(
      Effect.gen(function* () {
        const cases = yield* CaseRepository;
        const audit = yield* AuditLogService;
        const lifecycle = yield* CaseLifecycleWriter;
        const created = yield* cases.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("missing-package-agent"),
          status: "waiting_for_supplier",
          context: { riskFlags: ["existing"], source: "supplier-tool" },
        });

        const updated = yield* lifecycle.escalateToHuman({
          caseId: created.id,
          tenantId: TenantId("tenant-a"),
          actor: { type: "system", id: "supplier-notify" },
          reason: "supplier_unreachable",
          riskFlag: "supplier_unreachable",
          onlyFromStatus: "waiting_for_supplier",
          details: { escalationId: "e-cap", supplierEmail: "wh@x.com" },
        });

        const fetched = yield* cases.getById(created.id, TenantId("tenant-a"));
        const entries = yield* audit.forCase(created.id, {
          tenantId: TenantId("tenant-a"),
        });
        return { updated, fetched, entries };
      }),
    );

    expect(out.updated.status).toBe("human_takeover");
    expect(out.fetched.status).toBe("human_takeover");
    expect(out.fetched.context["source"]).toBe("supplier-tool");
    expect(out.fetched.context["riskFlags"]).toEqual([
      "existing",
      "supplier_unreachable",
    ]);
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]).toMatchObject({
      actor: { type: "system", id: "supplier-notify" },
      action: "case.escalated_to_human",
      details: {
        reason: "supplier_unreachable",
        escalationId: "e-cap",
        supplierEmail: "wh@x.com",
      },
    });
  });

  it("does not write when the expected source status no longer matches", async () => {
    const out = await run(
      Effect.gen(function* () {
        const cases = yield* CaseRepository;
        const audit = yield* AuditLogService;
        const lifecycle = yield* CaseLifecycleWriter;
        const created = yield* cases.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("missing-package-agent"),
          status: "in_progress",
          context: {},
        });

        const updated = yield* lifecycle.escalateToHuman({
          caseId: created.id,
          tenantId: TenantId("tenant-a"),
          actor: { type: "system", id: "supplier-notify" },
          reason: "supplier_unreachable",
          riskFlag: "supplier_unreachable",
          onlyFromStatus: "waiting_for_supplier",
          details: { escalationId: "e-cap" },
        });

        const fetched = yield* cases.getById(created.id, TenantId("tenant-a"));
        const entries = yield* audit.forCase(created.id, {
          tenantId: TenantId("tenant-a"),
        });
        return { updated, fetched, entries };
      }),
    );

    expect(out.updated.status).toBe("in_progress");
    expect(out.fetched.context["riskFlags"]).toBeUndefined();
    expect(out.entries).toEqual([]);
  });

  it("resolves through human takeover and clears selected risk flags", async () => {
    const out = await run(
      Effect.gen(function* () {
        const cases = yield* CaseRepository;
        const audit = yield* AuditLogService;
        const lifecycle = yield* CaseLifecycleWriter;
        const created = yield* cases.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("order-status-agent"),
          status: "human_takeover",
          context: {
            riskFlags: ["reply_delivery_failed", "manual_attention"],
            retryDeliveryId: "rd-1",
          },
        });

        const resolved = yield* lifecycle.resolve({
          caseId: created.id,
          tenantId: TenantId("tenant-a"),
          actor: { type: "system", id: "reply-delivery-retry" },
          reason: "reply delivered on retry",
          bridgeFromHumanTakeover: true,
          clearRiskFlags: ["reply_delivery_failed"],
          details: { reason: "reply_delivered_on_retry" },
        });

        const fetched = yield* cases.getById(created.id, TenantId("tenant-a"));
        const entries = yield* audit.forCase(created.id, {
          tenantId: TenantId("tenant-a"),
        });
        return { resolved, fetched, entries };
      }),
    );

    expect(out.resolved.status).toBe("resolved");
    expect(out.fetched.resolvedAt).not.toBeNull();
    expect(out.fetched.context["retryDeliveryId"]).toBe("rd-1");
    expect(out.fetched.context["riskFlags"]).toEqual(["manual_attention"]);
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]).toMatchObject({
      actor: { type: "system", id: "reply-delivery-retry" },
      action: "case.resolved",
      details: { reason: "reply_delivered_on_retry" },
    });
  });
});
