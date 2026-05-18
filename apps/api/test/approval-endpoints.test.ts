import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  decideApproval,
  extractToken,
  makePgBossApprovalPublisher,
  matchApprovalRoute,
  renderApprovalPage,
  type BossLike,
} from "../src/approval-endpoints.js";
import { randomUUID } from "node:crypto";
import {
  ApprovalService,
  signApprovalToken,
  ApprovalNotFound,
  ApprovalStateConflict,
  type ApprovalEndpointOutcome,
} from "@support-agent/services";
import type { Approval } from "@support-agent/agent-core";
import {
  ApprovalId,
  CaseId,
  TenantId,
  UserId,
  AgentId,
  type DomainEvent,
} from "@support-agent/agent-core";
import { ConnectorCredentialStore, type ConnectorConnection } from "@support-agent/services";
import { DbClient } from "@support-agent/db";

const SIGNING_KEY = "test-approval-signing-key";

const stubConnectorStore: Layer.Layer<ConnectorCredentialStore> = Layer.succeed(
  ConnectorCredentialStore,
  ConnectorCredentialStore.of({
    get: () =>
      Effect.fail({
        _tag: "ConnectorNotFound",
        provider: "shopify",
        tenantId: TenantId(""),
      } as never),
    put: () =>
      Effect.succeed({} as ConnectorConnection),
    revoke: () => Effect.succeed(undefined),
    listForTenant: () => Effect.succeed([] as ReadonlyArray<ConnectorConnection>),
    patchTokens: () =>
      Effect.succeed({} as ConnectorConnection),
    patchMetadata: () =>
      Effect.succeed({} as ConnectorConnection),
  }),
);

// DbClient stub — not used by these tests, but the ApiLayer type
// requires it so handlers can be composed. ApprovalServiceTest doesn't
// touch the DB, so this can be a never-throws no-op.
const stubDb = Layer.succeed(
  DbClient,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  null as any,
);

// Shared-store ApprovalService. ApprovalServiceTest from services builds
// a fresh Map every time the layer materializes, which fights the
// per-call Effect.provide pattern decideApproval uses internally. Here
// we close over a single Map so seed + decide + re-decide share state.
const makeSharedApprovalLayer = (): {
  readonly layer: Layer.Layer<ApprovalService>;
  readonly seed: (
    input: Omit<Approval, "id" | "status" | "decidedAt" | "decidedBy" | "decisionReason" | "approvedInput" | "createdAt">,
  ) => Approval;
} => {
  const store = new Map<string, Approval>();
  const seed = (
    input: Omit<Approval, "id" | "status" | "decidedAt" | "decidedBy" | "decisionReason" | "approvedInput" | "createdAt">,
  ): Approval => {
    const row: Approval = {
      ...input,
      id: randomUUID() as never,
      status: "pending",
      decidedAt: null,
      decidedBy: null,
      decisionReason: null,
      approvedInput: null,
      createdAt: new Date(),
    };
    store.set(row.id, row);
    return row;
  };
  const layer = Layer.succeed(
    ApprovalService,
    ApprovalService.of({
      create: (input) =>
        Effect.sync(() => seed(input as never)),
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

const makeLayer = (): {
  readonly layer: Layer.Layer<ApprovalService | ConnectorCredentialStore | DbClient>;
  readonly seed: ReturnType<typeof makeSharedApprovalLayer>["seed"];
} => {
  const shared = makeSharedApprovalLayer();
  return {
    layer: Layer.mergeAll(shared.layer, stubConnectorStore, stubDb),
    seed: shared.seed,
  };
};

describe("approval endpoints — pure helpers", () => {
  describe("matchApprovalRoute", () => {
    it("matches /approvals/<uuid>/approve", () => {
      const result = matchApprovalRoute(
        "/approvals/00000000-0000-0000-0000-000000000001/approve",
      );
      expect(result).toEqual({
        approvalId: "00000000-0000-0000-0000-000000000001",
        action: "approve",
      });
    });

    it("matches /approvals/<uuid>/reject", () => {
      const result = matchApprovalRoute(
        "/approvals/00000000-0000-0000-0000-000000000001/reject",
      );
      expect(result?.action).toBe("reject");
    });

    it("rejects non-uuid ids", () => {
      expect(matchApprovalRoute("/approvals/not-a-uuid/approve")).toBeNull();
    });

    it("rejects unknown actions", () => {
      expect(
        matchApprovalRoute(
          "/approvals/00000000-0000-0000-0000-000000000001/delete",
        ),
      ).toBeNull();
    });
  });

  describe("extractToken", () => {
    it("pulls ?token=", () => {
      expect(extractToken("/approvals/x/approve?token=abc.def.ghi")).toBe(
        "abc.def.ghi",
      );
    });
    it("returns null when missing", () => {
      expect(extractToken("/approvals/x/approve")).toBeNull();
    });
  });

  describe("renderApprovalPage", () => {
    it("renders distinct copy for approve vs reject", () => {
      const approval = {
        id: ApprovalId("a"),
        status: "approved",
        decidedAt: new Date(),
      } as never;
      const approve = renderApprovalPage(
        { kind: "decided", approval },
        "approve",
      );
      expect(approve.status).toBe(200);
      expect(approve.body).toContain("approved");
      const reject = renderApprovalPage(
        { kind: "decided", approval },
        "reject",
      );
      expect(reject.body).toContain("rejected");
    });
    it("returns 404 for approval_not_found", () => {
      const page = renderApprovalPage(
        { kind: "approval_not_found" },
        "approve",
      );
      expect(page.status).toBe(404);
    });
    it("returns 400 for bad_token", () => {
      const page = renderApprovalPage(
        { kind: "bad_token", reason: { ok: false, reason: "expired" } },
        "approve",
      );
      expect(page.status).toBe(400);
      expect(page.body).toContain("expired");
    });
  });
});

describe("decideApproval — orchestration", () => {
  const seedAndSign = (env: ReturnType<typeof makeLayer>) => {
    const row = env.seed({
      tenantId: TenantId("tenant-1"),
      caseId: CaseId("case-1"),
      agentId: AgentId("refund-review-agent"),
      tool: "conversation.reply",
      proposedInput: { hello: "world" },
      reasoning: "test",
      riskLevel: "medium",
      expiresAt: new Date(Date.now() + 60_000),
    } as never);
    const token = signApprovalToken({
      approvalId: row.id,
      secret: SIGNING_KEY,
      ttlMs: 60_000,
    });
    return { row, token };
  };

  it("happy path: approves a pending row + publishes approval.approved", async () => {
    const env = makeLayer();
    const { row, token } = seedAndSign(env);
    const published: DomainEvent[] = [];
    const outcome = await decideApproval({
      approvalId: row.id,
      action: "approve",
      token,
      signingKey: SIGNING_KEY,
      layer: env.layer as never,
      publish: async (e) => {
        published.push(e);
      },
    });
    expect(outcome.kind).toBe("decided");
    if (outcome.kind === "decided") {
      expect(outcome.approval.status).toBe("approved");
    }
    expect(published).toHaveLength(1);
    expect(published[0]?.type).toBe("approval.approved");
    if (published[0]?.type === "approval.approved") {
      expect(published[0].approvalId).toBe(row.id);
      expect(published[0].caseId).toBe(row.caseId);
    }
  });

  it("rejects + publishes approval.rejected", async () => {
    const env = makeLayer();
    const { row, token } = seedAndSign(env);
    const published: DomainEvent[] = [];
    const outcome = await decideApproval({
      approvalId: row.id,
      action: "reject",
      token,
      signingKey: SIGNING_KEY,
      layer: env.layer as never,
      publish: async (e) => {
        published.push(e);
      },
    });
    expect(outcome.kind).toBe("decided");
    expect(published[0]?.type).toBe("approval.rejected");
  });

  it("rejects a token signed with the wrong key", async () => {
    const env = makeLayer();
    const { row } = seedAndSign(env);
    const wrongToken = signApprovalToken({
      approvalId: row.id,
      secret: "different-key",
      ttlMs: 60_000,
    });
    const published: DomainEvent[] = [];
    const outcome = await decideApproval({
      approvalId: row.id,
      action: "approve",
      token: wrongToken,
      signingKey: SIGNING_KEY,
      layer: env.layer as never,
      publish: async (e) => {
        published.push(e);
      },
    });
    expect(outcome.kind).toBe("bad_token");
    expect(published).toHaveLength(0);
  });

  it("rejects when the token's approvalId doesn't match the URL id", async () => {
    const env = makeLayer();
    const { row } = seedAndSign(env);
    const otherToken = signApprovalToken({
      approvalId: "11111111-1111-1111-1111-111111111111",
      secret: SIGNING_KEY,
      ttlMs: 60_000,
    });
    const outcome = await decideApproval({
      approvalId: row.id,
      action: "approve",
      token: otherToken,
      signingKey: SIGNING_KEY,
      layer: env.layer as never,
      publish: async () => {},
    });
    expect(outcome.kind).toBe("token_mismatch");
  });

  it("idempotent re-click renders already_decided", async () => {
    const env = makeLayer();
    const { row, token } = seedAndSign(env);
    const published: DomainEvent[] = [];
    const publish = async (e: DomainEvent): Promise<void> => {
      published.push(e);
    };
    // First click — approves + publishes.
    await decideApproval({
      approvalId: row.id,
      action: "approve",
      token,
      signingKey: SIGNING_KEY,
      layer: env.layer as never,
      publish,
    });
    // Second click — already decided, NO new publish.
    const second = await decideApproval({
      approvalId: row.id,
      action: "approve",
      token,
      signingKey: SIGNING_KEY,
      layer: env.layer as never,
      publish,
    });
    expect(second.kind).toBe("already_decided");
    expect(published).toHaveLength(1);
  });

  it("returns approval_not_found for unknown ids", async () => {
    const env = makeLayer();
    const id = "11111111-1111-1111-1111-111111111111";
    const token = signApprovalToken({
      approvalId: id,
      secret: SIGNING_KEY,
      ttlMs: 60_000,
    });
    const outcome = await decideApproval({
      approvalId: id,
      action: "approve",
      token,
      signingKey: SIGNING_KEY,
      layer: env.layer as never,
      publish: async () => {},
    });
    expect(outcome.kind).toBe("approval_not_found");
  });
});

describe("makePgBossApprovalPublisher", () => {
  it("calls boss.send with workflow.events + singletonKey", async () => {
    const sent: Array<{ name: string; data: unknown; opts: unknown }> = [];
    const boss: BossLike = {
      send: async (name, data, opts) => {
        sent.push({ name, data, opts });
        return null;
      },
    };
    const publish = makePgBossApprovalPublisher(async () => boss);
    const event: DomainEvent = {
      type: "approval.approved",
      approvalId: ApprovalId("aaaa"),
      caseId: CaseId("bbbb"),
      managerId: UserId("cccc"),
    };
    await publish(event);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.name).toBe("workflow.events");
    const opts = sent[0]?.opts as { singletonKey?: string };
    expect(opts.singletonKey).toBeTypeOf("string");
  });
});
