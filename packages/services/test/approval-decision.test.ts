import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  applyApprovalDecision,
  decisionToEvent,
  ApprovalService,
  ApprovalNotFound,
  ApprovalStateConflict,
} from "../src/index.js";
import {
  AgentId,
  CaseId,
  TenantId,
  UserId,
  type Approval,
} from "@support-agent/agent-core";

// Build a shared-store ApprovalService Layer so seed + decide can
// share state across runPromise calls (the stock ApprovalServiceTest
// rebuilds its in-memory Map on every layer materialization).
const makeService = () => {
  const store = new Map<string, Approval>();

  const seed = (
    overrides: Partial<Approval> & {
      readonly tenantId: TenantId;
      readonly caseId: CaseId;
      readonly agentId: AgentId;
    },
  ): Approval => {
    const row: Approval = {
      id: randomUUID() as never,
      status: "pending",
      tool: "conversation.reply",
      proposedInput: {},
      reasoning: "",
      riskLevel: "medium",
      expiresAt: new Date(Date.now() + 60_000),
      decidedAt: null,
      decidedBy: null,
      decisionReason: null,
      approvedInput: null,
      createdAt: new Date(),
      ...overrides,
    };
    store.set(row.id, row);
    return row;
  };

  const layer = Layer.succeed(
    ApprovalService,
    ApprovalService.of({
      create: (input) => Effect.sync(() => seed(input as never)),
      getById: (id) => {
        const row = store.get(id);
        return row
          ? Effect.succeed(row)
          : Effect.fail(new ApprovalNotFound({ approvalId: id }));
      },
      approve: ({ id, decidedBy, approvedInput, decisionReason }) => {
        const row = store.get(id);
        if (!row)
          return Effect.fail(new ApprovalNotFound({ approvalId: id }));
        if (row.status !== "pending")
          return Effect.fail(
            new ApprovalStateConflict({
              approvalId: id,
              expected: "pending",
              actual: row.status,
            }),
          );
        const next: Approval = {
          ...row,
          status: "approved",
          decidedAt: new Date(),
          decidedBy,
          approvedInput: approvedInput ?? null,
          decisionReason: decisionReason ?? null,
        };
        store.set(id, next);
        return Effect.succeed(next);
      },
      reject: ({ id, decidedBy, decisionReason }) => {
        const row = store.get(id);
        if (!row)
          return Effect.fail(new ApprovalNotFound({ approvalId: id }));
        if (row.status !== "pending")
          return Effect.fail(
            new ApprovalStateConflict({
              approvalId: id,
              expected: "pending",
              actual: row.status,
            }),
          );
        const next: Approval = {
          ...row,
          status: "rejected",
          decidedAt: new Date(),
          decidedBy,
          decisionReason: decisionReason ?? null,
        };
        store.set(id, next);
        return Effect.succeed(next);
      },
      listPending: () =>
        Effect.succeed(
          [...store.values()].filter((r) => r.status === "pending"),
        ),
    }),
  );

  return { layer, seed };
};

const tenantA = TenantId("11111111-1111-1111-1111-111111111111");
const tenantB = TenantId("22222222-2222-2222-2222-222222222222");
const caseA = CaseId("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
const agentId = AgentId("refund-review-agent");
const manager = UserId("manager-1");

describe("applyApprovalDecision", () => {
  it("approves a pending row", async () => {
    const svc = makeService();
    const row = svc.seed({
      tenantId: tenantA,
      caseId: caseA,
      agentId,
    });
    const result = await Effect.runPromise(
      Effect.provide(
        applyApprovalDecision({
          approvalId: row.id,
          action: "approve",
          managerId: manager,
        }),
        svc.layer,
      ),
    );
    expect(result.kind).toBe("decided");
    if (result.kind === "decided") {
      expect(result.approval.status).toBe("approved");
      expect(result.approval.decidedBy).toBe(manager);
    }
  });

  it("approves with manager-edited approvedInput (Edit-and-Approve path)", async () => {
    const svc = makeService();
    const row = svc.seed({
      tenantId: tenantA,
      caseId: caseA,
      agentId,
      proposedInput: { bodyText: "draft from agent", subject: null },
    });
    const result = await Effect.runPromise(
      Effect.provide(
        applyApprovalDecision({
          approvalId: row.id,
          action: "approve",
          managerId: manager,
          approvedInput: {
            bodyText: "manager-edited version",
            subject: null,
          },
        }),
        svc.layer,
      ),
    );
    expect(result.kind).toBe("decided");
    if (result.kind === "decided") {
      expect(result.approval.status).toBe("approved");
      // Runtime resume reads `approvedInput ?? proposedInput` — the
      // edit must land in the column for the customer to see it.
      const edited = result.approval.approvedInput as {
        readonly bodyText: string;
      };
      expect(edited.bodyText).toBe("manager-edited version");
    }
  });

  it("ignores approvedInput on reject", async () => {
    const svc = makeService();
    const row = svc.seed({
      tenantId: tenantA,
      caseId: caseA,
      agentId,
    });
    const result = await Effect.runPromise(
      Effect.provide(
        applyApprovalDecision({
          approvalId: row.id,
          action: "reject",
          managerId: manager,
          approvedInput: { bodyText: "should not be saved" },
        }),
        svc.layer,
      ),
    );
    expect(result.kind).toBe("decided");
    if (result.kind === "decided") {
      expect(result.approval.status).toBe("rejected");
      expect(result.approval.approvedInput).toBeNull();
    }
  });

  it("rejects a pending row", async () => {
    const svc = makeService();
    const row = svc.seed({
      tenantId: tenantA,
      caseId: caseA,
      agentId,
    });
    const result = await Effect.runPromise(
      Effect.provide(
        applyApprovalDecision({
          approvalId: row.id,
          action: "reject",
          managerId: manager,
        }),
        svc.layer,
      ),
    );
    expect(result.kind).toBe("decided");
    if (result.kind === "decided") {
      expect(result.approval.status).toBe("rejected");
    }
  });

  it("returns approval_not_found for cross-tenant ids when scoped", async () => {
    const svc = makeService();
    const row = svc.seed({
      tenantId: tenantA,
      caseId: caseA,
      agentId,
    });
    // Same id, but caller claims a different tenant — the row exists
    // in tenantA but we ask for it as tenantB. Must surface as
    // not-found (don't disclose existence).
    const result = await Effect.runPromise(
      Effect.provide(
        applyApprovalDecision({
          approvalId: row.id,
          action: "approve",
          managerId: manager,
          tenantId: tenantB,
        }),
        svc.layer,
      ),
    );
    expect(result.kind).toBe("approval_not_found");
    // The row in storage was NOT touched.
    const reread = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const s = yield* ApprovalService;
          return yield* s.getById(row.id as never);
        }),
        svc.layer,
      ),
    );
    expect(reread.status).toBe("pending");
  });

  it("returns already_decided on re-decide (idempotency)", async () => {
    const svc = makeService();
    const row = svc.seed({
      tenantId: tenantA,
      caseId: caseA,
      agentId,
    });
    // First decision succeeds.
    await Effect.runPromise(
      Effect.provide(
        applyApprovalDecision({
          approvalId: row.id,
          action: "approve",
          managerId: manager,
        }),
        svc.layer,
      ),
    );
    // Second decision sees the row already in `approved` and returns
    // already_decided. No state change.
    const second = await Effect.runPromise(
      Effect.provide(
        applyApprovalDecision({
          approvalId: row.id,
          action: "reject",
          managerId: manager,
        }),
        svc.layer,
      ),
    );
    expect(second.kind).toBe("already_decided");
    if (second.kind === "already_decided") {
      expect(second.approval.status).toBe("approved");
    }
  });

  it("returns approval_not_found for an unknown id", async () => {
    const svc = makeService();
    const result = await Effect.runPromise(
      Effect.provide(
        applyApprovalDecision({
          approvalId: "00000000-0000-0000-0000-000000000000",
          action: "approve",
          managerId: manager,
        }),
        svc.layer,
      ),
    );
    expect(result.kind).toBe("approval_not_found");
  });
});

describe("decisionToEvent", () => {
  it("maps a decided approve to approval.approved", () => {
    const approval = {
      id: "appr-1",
      caseId: "case-1",
    } as never;
    const event = decisionToEvent(
      { kind: "decided", approval },
      "approve",
      manager,
    );
    expect(event?.type).toBe("approval.approved");
  });

  it("maps a decided reject to approval.rejected", () => {
    const approval = {
      id: "appr-1",
      caseId: "case-1",
    } as never;
    const event = decisionToEvent(
      { kind: "decided", approval },
      "reject",
      manager,
    );
    expect(event?.type).toBe("approval.rejected");
  });

  it("returns null for non-decided outcomes", () => {
    expect(
      decisionToEvent({ kind: "approval_not_found" }, "approve", manager),
    ).toBeNull();
    expect(
      decisionToEvent(
        { kind: "already_decided", approval: { id: "x" } as never },
        "approve",
        manager,
      ),
    ).toBeNull();
  });
});
