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

  it("distinguishes the same provider thread id across tenant mailboxes", async () => {
    const result = await newRun(
      Effect.gen(function* () {
        const repo = yield* CaseRepository;
        const first = yield* repo.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("support-triage"),
          threadId: ThreadId("gmail:thread-1"),
          provider: "gmail",
          mailbox: "first@merchant.com",
        });
        const second = yield* repo.create({
          tenantId: TenantId("tenant-a"),
          channel: "email",
          currentAgentId: AgentId("support-triage"),
          threadId: ThreadId("gmail:thread-1"),
          provider: "gmail",
          mailbox: "second@merchant.com",
        });
        return {
          first: yield* repo.findByThreadId(
            TenantId("tenant-a"),
            ThreadId("gmail:thread-1"),
            "gmail",
            "first@merchant.com",
          ),
          second: yield* repo.findByThreadId(
            TenantId("tenant-a"),
            ThreadId("gmail:thread-1"),
            "gmail",
            "second@merchant.com",
          ),
          firstId: first.id,
          secondId: second.id,
        };
      }),
    );
    expect(result.first?.id).toBe(result.firstId);
    expect(result.second?.id).toBe(result.secondId);
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
    expect(result.archivedAt).toBeNull();
  });

  it("transitionStatus changes status and sets archivedAt on archived", async () => {
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
        return yield* repo.transitionStatus(resolved.id, "archived", {
          expectedFromStatus: "resolved",
          reason: "retention",
        });
      }),
    );
    expect(result.status).toBe("archived");
    expect(result.resolvedAt).not.toBeNull();
    expect(result.archivedAt).not.toBeNull();
  });

  it("transitionStatus clears archivedAt when an archived case reopens", async () => {
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
        const archived = yield* repo.transitionStatus(resolved.id, "archived", {
          expectedFromStatus: "resolved",
          reason: "retention",
        });
        return yield* repo.transitionStatus(archived.id, "in_progress", {
          expectedFromStatus: "archived",
          reason: "customer reply",
        });
      }),
    );
    expect(result.status).toBe("in_progress");
    expect(result.resolvedAt).not.toBeNull();
    expect(result.archivedAt).toBeNull();
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

  it("recordMessageId + findByMessageIds correlate a reply to its case", async () => {
    const result = await newRun(
      Effect.gen(function* () {
        const repo = yield* CaseRepository;
        const c = yield* repo.create({
          tenantId: TenantId("t1"),
          channel: "email",
          currentAgentId: AgentId("support-triage"),
        });
        yield* repo.recordMessageId({
          tenantId: TenantId("t1"),
          caseId: c.id,
          messageId: "m1@h",
          direction: "inbound",
        });
        // A reply that cites m1@h anywhere in its candidate ids resolves.
        const hit = yield* repo.findByMessageIds(TenantId("t1"), [
          "nope@h",
          "m1@h",
        ]);
        const miss = yield* repo.findByMessageIds(TenantId("t1"), ["other@h"]);
        // Scoped by tenant: another tenant citing the same id sees nothing.
        const crossTenant = yield* repo.findByMessageIds(TenantId("t2"), [
          "m1@h",
        ]);
        return { caseId: c.id, hitId: hit?.id, miss, crossTenant };
      }),
    );
    expect(result.hitId).toBe(result.caseId);
    expect(result.miss).toBeNull();
    expect(result.crossTenant).toBeNull();
  });

  it("recordMessageId is idempotent — first writer keeps the mapping", async () => {
    const result = await newRun(
      Effect.gen(function* () {
        const repo = yield* CaseRepository;
        const mk = () =>
          repo.create({
            tenantId: TenantId("t1"),
            channel: "email" as const,
            currentAgentId: AgentId("support-triage"),
          });
        const a = yield* mk();
        const b = yield* mk();
        yield* repo.recordMessageId({
          tenantId: TenantId("t1"),
          caseId: a.id,
          messageId: "dup@h",
          direction: "inbound",
        });
        // A second record of the same id (e.g. redelivered) is a no-op.
        yield* repo.recordMessageId({
          tenantId: TenantId("t1"),
          caseId: b.id,
          messageId: "dup@h",
          direction: "outbound",
        });
        const hit = yield* repo.findByMessageIds(TenantId("t1"), ["dup@h"]);
        return { aId: a.id, hitId: hit?.id };
      }),
    );
    expect(result.hitId).toBe(result.aId);
  });
});
