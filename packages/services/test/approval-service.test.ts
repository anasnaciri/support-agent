import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentId,
  CaseId,
  TenantId,
  UserId,
} from "@support-agent/agent-core";
import {
  ApprovalNotFound,
  ApprovalService,
  ApprovalServiceTest,
  ApprovalStateConflict,
} from "../src/approval-service.js";

const newRun = <A, E>(eff: Effect.Effect<A, E, ApprovalService>) =>
  Effect.runPromise(Effect.provide(eff, ApprovalServiceTest));

const newRunExit = <A, E>(eff: Effect.Effect<A, E, ApprovalService>) =>
  Effect.runPromiseExit(Effect.provide(eff, ApprovalServiceTest));

const fixedFuture = new Date(Date.now() + 24 * 60 * 60 * 1000);

const sampleCreate = {
  tenantId: TenantId("t1"),
  caseId: CaseId("c1"),
  agentId: AgentId("support-triage"),
  tool: "refund.create",
  proposedInput: { amountCents: 2000 },
  reasoning: "Customer asked for partial refund.",
  riskLevel: "high" as const,
  expiresAt: fixedFuture,
};

describe("ApprovalService (Test layer)", () => {
  it("create persists an approval in 'pending' state with no decision yet", async () => {
    const approval = await newRun(
      Effect.gen(function* () {
        const svc = yield* ApprovalService;
        return yield* svc.create(sampleCreate);
      }),
    );
    expect(approval.status).toBe("pending");
    expect(approval.decidedBy).toBeNull();
    expect(approval.decidedAt).toBeNull();
    expect(approval.approvedInput).toBeNull();
    expect(approval.tool).toBe("refund.create");
    expect(approval.riskLevel).toBe("high");
  });

  it("approve transitions pending → approved with decidedBy/decidedAt", async () => {
    const approved = await newRun(
      Effect.gen(function* () {
        const svc = yield* ApprovalService;
        const created = yield* svc.create(sampleCreate);
        return yield* svc.approve({
          id: created.id,
          decidedBy: UserId("u-manager"),
          decisionReason: "ok",
        });
      }),
    );
    expect(approved.status).toBe("approved");
    expect(approved.decidedBy).toBe("u-manager");
    expect(approved.decisionReason).toBe("ok");
    expect(approved.decidedAt).toBeInstanceOf(Date);
  });

  it("approve with approvedInput records the manager's edits", async () => {
    const approved = await newRun(
      Effect.gen(function* () {
        const svc = yield* ApprovalService;
        const created = yield* svc.create(sampleCreate);
        return yield* svc.approve({
          id: created.id,
          decidedBy: UserId("u-manager"),
          approvedInput: { amountCents: 1500 },
        });
      }),
    );
    expect(approved.approvedInput).toEqual({ amountCents: 1500 });
  });

  it("reject transitions pending → rejected", async () => {
    const rejected = await newRun(
      Effect.gen(function* () {
        const svc = yield* ApprovalService;
        const created = yield* svc.create(sampleCreate);
        return yield* svc.reject({
          id: created.id,
          decidedBy: UserId("u-manager"),
          decisionReason: "policy violation",
        });
      }),
    );
    expect(rejected.status).toBe("rejected");
    expect(rejected.decisionReason).toBe("policy violation");
  });

  it("approving an already-resolved approval fails with ApprovalStateConflict", async () => {
    const exit = await newRunExit(
      Effect.gen(function* () {
        const svc = yield* ApprovalService;
        const created = yield* svc.create(sampleCreate);
        yield* svc.approve({
          id: created.id,
          decidedBy: UserId("u-manager"),
        });
        return yield* svc.approve({
          id: created.id,
          decidedBy: UserId("u-other"),
        });
      }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(ApprovalStateConflict);
    }
  });

  it("getById for an unknown id fails with ApprovalNotFound", async () => {
    const exit = await newRunExit(
      Effect.gen(function* () {
        const svc = yield* ApprovalService;
        return yield* svc.getById("nope" as never);
      }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(ApprovalNotFound);
    }
  });

  it("listPending returns only pending approvals for the requested tenant", async () => {
    const result = await newRun(
      Effect.gen(function* () {
        const svc = yield* ApprovalService;
        // pending for t1
        yield* svc.create(sampleCreate);
        yield* svc.create(sampleCreate);
        // approved for t1 — should NOT appear
        const decided = yield* svc.create(sampleCreate);
        yield* svc.approve({
          id: decided.id,
          decidedBy: UserId("u-manager"),
        });
        // pending for t2 — should NOT appear
        yield* svc.create({ ...sampleCreate, tenantId: TenantId("t2") });
        return yield* svc.listPending(TenantId("t1"));
      }),
    );
    expect(result).toHaveLength(2);
    for (const a of result) {
      expect(a.tenantId).toBe("t1");
      expect(a.status).toBe("pending");
    }
  });
});
