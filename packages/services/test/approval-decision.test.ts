import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  applyApprovalDecision,
  decideApprovalBundle,
  decisionToEvent,
  ApprovalService,
  ApprovalServiceDbError,
  ApprovalNotFound,
  ApprovalStateConflict,
} from "../src/index.js";
import {
  AgentId,
  TicketId,
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
      readonly ticketId: TicketId;
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
      listForTicket: (_tenantId, ticketId) =>
        Effect.succeed(
          [...store.values()].filter((r) => r.ticketId === ticketId),
        ),
    }),
  );

  return { layer, seed, store };
};

const tenantA = TenantId("11111111-1111-1111-1111-111111111111");
const tenantB = TenantId("22222222-2222-2222-2222-222222222222");
const ticketA = TicketId("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
const agentId = AgentId("refund-review-agent");
const manager = UserId("manager-1");

describe("applyApprovalDecision", () => {
  it("approves a pending row", async () => {
    const svc = makeService();
    const row = svc.seed({
      tenantId: tenantA,
      ticketId: ticketA,
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

  it("decides a stale (past-expiry) pending approval — tool age never blocks", async () => {
    const svc = makeService();
    const row = svc.seed({
      tenantId: tenantA,
      ticketId: ticketA,
      agentId,
      // Drafted well over a day ago. Approval drafts no longer expire by
      // age for ANY tool, so a late decision must still go through.
      expiresAt: new Date(Date.now() - 60_000),
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
    const after = svc.store.get(row.id);
    expect(after?.status).toBe("approved");
  });

  it("approves with manager-edited approvedInput (Edit-and-Approve path)", async () => {
    const svc = makeService();
    const row = svc.seed({
      tenantId: tenantA,
      ticketId: ticketA,
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
      ticketId: ticketA,
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
      ticketId: ticketA,
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
      ticketId: ticketA,
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

  it("does not report already_decided when the transition write fails", async () => {
    const row: Approval = {
      id: randomUUID() as never,
      tenantId: tenantA,
      ticketId: ticketA,
      agentId,
      status: "pending",
      tool: "conversation.reply",
      proposedInput: {},
      approvedInput: null,
      reasoning: "",
      riskLevel: "medium",
      decidedBy: null,
      decidedAt: null,
      decisionReason: null,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    };
    const layer = Layer.succeed(
      ApprovalService,
      ApprovalService.of({
        create: () => Effect.succeed(row),
        getById: () => Effect.succeed(row),
        approve: () =>
          Effect.fail(
            new ApprovalServiceDbError({
              operation: "transition",
              cause: "invalid decided_by",
            }),
          ),
        reject: () =>
          Effect.fail(
            new ApprovalServiceDbError({
              operation: "transition",
              cause: "invalid decided_by",
            }),
          ),
        listPending: () => Effect.succeed([row]),
      }),
    );

    await expect(
      Effect.runPromise(
        Effect.provide(
          applyApprovalDecision({
            approvalId: row.id,
            action: "approve",
            managerId: manager,
          }),
          layer,
        ),
      ),
    ).rejects.toThrow();
  });

  it("returns already_decided on re-decide (idempotency)", async () => {
    const svc = makeService();
    const row = svc.seed({
      tenantId: tenantA,
      ticketId: ticketA,
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
      ticketId: "ticket-1",
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
      ticketId: "ticket-1",
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

describe("decideApprovalBundle", () => {
  const TENANT = TenantId("t-bundle");
  const AGENT = AgentId("scenario-resolution-agent");
  const MANAGER = UserId("mgr-1");

  it("approves every pending row for the ticket and returns one approve event", async () => {
    const { layer, seed, store } = makeService();
    const ticketId = TicketId("ticket-A");
    const a = seed({ tenantId: TENANT, ticketId, agentId: AGENT, tool: "refund.create" });
    const b = seed({ tenantId: TENANT, ticketId, agentId: AGENT, tool: "conversation.reply" });
    // A different ticket's pending row must be untouched (scope).
    const other = seed({
      tenantId: TENANT,
      ticketId: TicketId("ticket-B"),
      agentId: AGENT,
      tool: "conversation.reply",
    });

    const out = await Effect.runPromise(
      Effect.provide(
        decideApprovalBundle({
          tenantId: TENANT,
          ticketId,
          action: "approve",
          managerId: MANAGER,
        }),
        layer,
      ),
    );

    expect(out.pendingCount).toBe(2);
    expect(out.decidedCount).toBe(2);
    expect(out.event?.type).toBe("approval.approved");
    expect(store.get(a.id)?.status).toBe("approved");
    expect(store.get(b.id)?.status).toBe("approved");
    // Untouched.
    expect(store.get(other.id)?.status).toBe("pending");
  });

  it("rejects every pending row and returns one reject event", async () => {
    const { layer, seed, store } = makeService();
    const ticketId = TicketId("ticket-R");
    const a = seed({ tenantId: TENANT, ticketId, agentId: AGENT });
    const b = seed({ tenantId: TENANT, ticketId, agentId: AGENT });

    const out = await Effect.runPromise(
      Effect.provide(
        decideApprovalBundle({
          tenantId: TENANT,
          ticketId,
          action: "reject",
          managerId: MANAGER,
        }),
        layer,
      ),
    );

    expect(out.decidedCount).toBe(2);
    expect(out.event?.type).toBe("approval.rejected");
    expect(store.get(a.id)?.status).toBe("rejected");
    expect(store.get(b.id)?.status).toBe("rejected");
  });

  it("reject only decides the still-pending rows, leaving an already-approved row untouched", async () => {
    // Per-action flow: the operator approved one action earlier, then rejects.
    // Reject must only reject the REMAINING (pending) rows — never un-decide the
    // one already approved (and executed).
    const { layer, seed, store } = makeService();
    const ticketId = TicketId("ticket-mixed");
    const approved = seed({
      tenantId: TENANT,
      ticketId,
      agentId: AGENT,
      tool: "refund.create",
      status: "approved",
    });
    const pending = seed({
      tenantId: TENANT,
      ticketId,
      agentId: AGENT,
      tool: "conversation.reply",
    });

    const out = await Effect.runPromise(
      Effect.provide(
        decideApprovalBundle({
          tenantId: TENANT,
          ticketId,
          action: "reject",
          managerId: MANAGER,
        }),
        layer,
      ),
    );

    expect(out.pendingCount).toBe(1);
    expect(out.decidedCount).toBe(1);
    expect(store.get(approved.id)?.status).toBe("approved"); // untouched
    expect(store.get(pending.id)?.status).toBe("rejected");
  });

  it("applies a per-approval edited input on approve", async () => {
    const { layer, seed, store } = makeService();
    const ticketId = TicketId("ticket-E");
    const reply = seed({
      tenantId: TENANT,
      ticketId,
      agentId: AGENT,
      tool: "conversation.reply",
      proposedInput: { bodyText: "original" },
    });

    await Effect.runPromise(
      Effect.provide(
        decideApprovalBundle({
          tenantId: TENANT,
          ticketId,
          action: "approve",
          managerId: MANAGER,
          edits: { [reply.id]: { bodyText: "edited by manager" } },
        }),
        layer,
      ),
    );

    expect(store.get(reply.id)?.approvedInput).toEqual({
      bodyText: "edited by manager",
    });
  });

  it("is a no-op (no event) when the ticket has no pending approvals", async () => {
    const { layer } = makeService();
    const out = await Effect.runPromise(
      Effect.provide(
        decideApprovalBundle({
          tenantId: TENANT,
          ticketId: TicketId("empty"),
          action: "approve",
          managerId: MANAGER,
        }),
        layer,
      ),
    );
    expect(out.pendingCount).toBe(0);
    expect(out.decidedCount).toBe(0);
    expect(out.event).toBeNull();
  });
});
