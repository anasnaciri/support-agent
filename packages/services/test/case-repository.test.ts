import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentId,
  TenantId,
  ThreadId,
} from "@support-agent/agent-core";
import {
  CaseNotFound,
  CaseRepository,
  CaseRepositoryTest,
  CaseStateConflict,
} from "../src/case-repository.js";

const run = <A, E>(eff: Effect.Effect<A, E, CaseRepository>) =>
  Effect.runPromiseExit(Effect.provide(eff, CaseRepositoryTest));

const newRun = <A, E>(eff: Effect.Effect<A, E, CaseRepository>) =>
  Effect.runPromise(Effect.provide(eff, CaseRepositoryTest));

describe("CaseRepository (Test layer)", () => {
  it("create + getById round-trip", async () => {
    const result = await newRun(
      Effect.gen(function* () {
        const repo = yield* CaseRepository;
        const created = yield* repo.create({
          tenantId: TenantId("t1"),
          channel: "email",
          currentAgentId: AgentId("support-triage"),
        });
        const fetched = yield* repo.getById(created.id);
        return { created, fetched };
      }),
    );
    expect(result.created.id).toBe(result.fetched.id);
    expect(result.fetched.status).toBe("new");
    expect(result.fetched.currentAgentId).toBe("support-triage");
  });

  it("getById fails with CaseNotFound for an unknown id", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const repo = yield* CaseRepository;
        return yield* repo.getById("nonexistent" as never);
      }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const err = exit.cause._tag === "Fail" ? exit.cause.error : null;
      expect(err).toBeInstanceOf(CaseNotFound);
    }
  });

  it("findByThreadId returns the case scoped to tenant", async () => {
    const result = await newRun(
      Effect.gen(function* () {
        const repo = yield* CaseRepository;
        const a = yield* repo.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("support-triage"),
          threadId: ThreadId("thread-1"),
        });
        // same threadId but different tenant — must not collide
        yield* repo.create({
          tenantId: TenantId("tenant-b"),
          channel: "email",
          currentAgentId: AgentId("support-triage"),
          threadId: ThreadId("thread-1"),
        });
        const found = yield* repo.findByThreadId(
          TenantId("tenant-a"),
          ThreadId("thread-1"),
        );
        const miss = yield* repo.findByThreadId(
          TenantId("tenant-a"),
          ThreadId("thread-unknown"),
        );
        return { aId: a.id, found, miss };
      }),
    );
    expect(result.found?.id).toBe(result.aId);
    expect(result.miss).toBeNull();
  });

  it("update applies a partial patch and bumps updatedAt", async () => {
    const result = await newRun(
      Effect.gen(function* () {
        const repo = yield* CaseRepository;
        const created = yield* repo.create({
          tenantId: TenantId("t1"),
          channel: "email",
          currentAgentId: AgentId("support-triage"),
        });
        const updated = yield* repo.update(created.id, {
          category: "where_is_order",
          context: { classification: "order_status_inquiry" },
        });
        return { created, updated };
      }),
    );
    expect(result.updated.category).toBe("where_is_order");
    expect(result.updated.context["classification"]).toBe(
      "order_status_inquiry",
    );
    expect(result.updated.updatedAt.getTime()).toBeGreaterThanOrEqual(
      result.created.updatedAt.getTime(),
    );
  });

  it("transitionStatus changes status and sets resolvedAt on resolved", async () => {
    const result = await newRun(
      Effect.gen(function* () {
        const repo = yield* CaseRepository;
        const c = yield* repo.create({
          tenantId: TenantId("t1"),
          channel: "email",
          currentAgentId: AgentId("support-triage"),
        });
        const resolved = yield* repo.transitionStatus(c.id, "resolved", {
          expectedFromStatus: "new",
          reason: "test",
        });
        return resolved;
      }),
    );
    expect(result.status).toBe("resolved");
    expect(result.resolvedAt).not.toBeNull();
  });

  it("transitionStatus fails with CaseStateConflict when expected does not match", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const repo = yield* CaseRepository;
        const c = yield* repo.create({
          tenantId: TenantId("t1"),
          channel: "email",
          currentAgentId: AgentId("support-triage"),
          status: "in_progress",
        });
        return yield* repo.transitionStatus(c.id, "resolved", {
          expectedFromStatus: "new",
        });
      }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(CaseStateConflict);
    }
  });
});
