import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  ApprovalService,
  ApprovalNotFound,
  ApprovalStateConflict,
  TicketRepository,
  TicketNotFound,
  signApprovalToken,
  signBundleReviewToken,
} from "@support-agent/services";
import {
  AgentId,
  ApprovalId,
  TenantId,
  TicketId,
  UserId,
  type Approval,
  type DomainEvent,
  type Ticket,
} from "@support-agent/agent-core";
import {
  decideBundleFromLink,
  loadBundleReview,
  renderBundleDecisionPage,
  renderBundleReviewErrorPage,
  renderBundleReviewPage,
} from "../bundle-endpoints.js";
import type { ApiLayer } from "../../../bootstrap.js";

const SIGNING_KEY = "test-approval-signing-key";
const TENANT = TenantId("tenant-1");
const TICKET = TicketId("7c8a4f0e-6f2a-4b57-9d3a-2f1e5c9b8a70");

const makeTicket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: TICKET,
  tenantId: TENANT,
  customerId: null,
  orderId: null,
  channel: "email",
  threadId: null,
  mailbox: null,
  status: "waiting_for_approval",
  currentAgentId: AgentId("scenario-resolution"),
  priority: "normal",
  summary: null,
  subject: "Where is my order?",
  context: { customerEmail: "jane@example.com" },
  createdAt: new Date(),
  updatedAt: new Date(),
  resolvedAt: null,
  ...overrides,
});

interface Env {
  readonly layer: ApiLayer;
  readonly seed: (input: {
    readonly tool: string;
    readonly proposedInput: unknown;
    readonly status?: Approval["status"];
  }) => Approval;
  readonly store: Map<string, Approval>;
}

const makeEnv = (ticket: Ticket | null = makeTicket()): Env => {
  const store = new Map<string, Approval>();
  const seed: Env["seed"] = ({ tool, proposedInput, status }) => {
    const row: Approval = {
      id: ApprovalId(randomUUID()),
      tenantId: TENANT,
      ticketId: TICKET,
      agentId: AgentId("scenario-resolution"),
      tool,
      proposedInput,
      approvedInput: null,
      reasoning: "queued by the loop",
      riskLevel: "medium",
      status: status ?? "pending",
      decidedBy: null,
      decidedAt: null,
      decisionReason: null,
      expiresAt: new Date(Date.now() + 86_400_000),
      createdAt: new Date(),
    };
    store.set(row.id, row);
    return row;
  };

  const approvalLayer = Layer.succeed(
    ApprovalService,
    {
      getById: (id: string) => {
        const row = store.get(id);
        return row
          ? Effect.succeed(row)
          : Effect.fail(new ApprovalNotFound({ approvalId: id }));
      },
      approve: ({ id, decidedBy }: { id: string; decidedBy: UserId }) => {
        const row = store.get(id);
        if (!row) return Effect.fail(new ApprovalNotFound({ approvalId: id }));
        if (row.status !== "pending") {
          return Effect.fail(
            new ApprovalStateConflict({
              approvalId: id,
              expected: "pending",
              actual: row.status,
            }),
          );
        }
        const next: Approval = {
          ...row,
          status: "approved",
          decidedBy,
          decidedAt: new Date(),
        };
        store.set(id, next);
        return Effect.succeed(next);
      },
      reject: ({ id, decidedBy }: { id: string; decidedBy: UserId }) => {
        const row = store.get(id);
        if (!row) return Effect.fail(new ApprovalNotFound({ approvalId: id }));
        if (row.status !== "pending") {
          return Effect.fail(
            new ApprovalStateConflict({
              approvalId: id,
              expected: "pending",
              actual: row.status,
            }),
          );
        }
        const next: Approval = {
          ...row,
          status: "rejected",
          decidedBy,
          decidedAt: new Date(),
        };
        store.set(id, next);
        return Effect.succeed(next);
      },
      listForTicket: (_tenantId: TenantId, ticketId: TicketId) =>
        Effect.succeed(
          [...store.values()]
            .filter((r) => r.ticketId === ticketId)
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
        ),
      listPending: () =>
        Effect.succeed(
          [...store.values()].filter((r) => r.status === "pending"),
        ),
    } as never,
  );

  const ticketLayer = Layer.succeed(
    TicketRepository,
    {
      getById: (id: TicketId) =>
        ticket && ticket.id === id
          ? Effect.succeed(ticket)
          : Effect.fail(new TicketNotFound({ ticketId: id })),
    } as never,
  );

  return {
    layer: Layer.mergeAll(approvalLayer, ticketLayer) as unknown as ApiLayer,
    seed,
    store,
  };
};

const reviewToken = (ticketId: string = TICKET) =>
  signBundleReviewToken({ ticketId, secret: SIGNING_KEY, ttlMs: 60_000 });

const seedTwo = (env: Env) => {
  const reply = env.seed({
    tool: "conversation.reply",
    proposedInput: {
      bodyText: "Hi Jane, your refund is on the way.",
      subject: null,
    },
  });
  const refund = env.seed({
    tool: "refund.create",
    proposedInput: {
      orderId: "gid://shopify/Order/123",
      amount: { amount: "23.50", currencyCode: "EUR" },
    },
  });
  return { reply, refund };
};

describe("loadBundleReview", () => {
  it("returns the ticket and its pending rows for a valid token", async () => {
    const env = makeEnv();
    seedTwo(env);
    env.seed({
      tool: "merchant.notify",
      proposedInput: {},
      status: "approved",
    });

    const outcome = await loadBundleReview({
      ticketId: TICKET,
      token: reviewToken(),
      signingKey: SIGNING_KEY,
      layer: env.layer,
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.ticket.id).toBe(TICKET);
      // Only PENDING rows are up for review — decided ones are history.
      expect(outcome.pending).toHaveLength(2);
    }
  });

  it("rejects a single-approval token (cross-surface replay)", async () => {
    const env = makeEnv();
    seedTwo(env);
    const token = signApprovalToken({
      approvalId: TICKET,
      action: "approve",
      secret: SIGNING_KEY,
      ttlMs: 60_000,
    });
    const outcome = await loadBundleReview({
      ticketId: TICKET,
      token,
      signingKey: SIGNING_KEY,
      layer: env.layer,
    });
    expect(outcome.kind).toBe("bad_token");
  });

  it("rejects a token minted for a different ticket", async () => {
    const env = makeEnv();
    seedTwo(env);
    const outcome = await loadBundleReview({
      ticketId: TICKET,
      token: reviewToken("11111111-2222-3333-4444-555555555555"),
      signingKey: SIGNING_KEY,
      layer: env.layer,
    });
    expect(outcome.kind).toBe("token_mismatch");
  });

  it("rejects an expired token", async () => {
    const env = makeEnv();
    const token = signBundleReviewToken({
      ticketId: TICKET,
      secret: SIGNING_KEY,
      ttlMs: 1,
      nowMs: Date.now() - 10_000,
    });
    const outcome = await loadBundleReview({
      ticketId: TICKET,
      token,
      signingKey: SIGNING_KEY,
      layer: env.layer,
    });
    expect(outcome.kind).toBe("bad_token");
    if (outcome.kind === "bad_token") {
      expect(outcome.reason).toBe("expired");
    }
  });

  it("reports a missing ticket", async () => {
    const env = makeEnv(null);
    const outcome = await loadBundleReview({
      ticketId: TICKET,
      token: reviewToken(),
      signingKey: SIGNING_KEY,
      layer: env.layer,
    });
    expect(outcome.kind).toBe("ticket_not_found");
  });

  it("reports an already-decided bundle", async () => {
    const env = makeEnv();
    env.seed({
      tool: "conversation.reply",
      proposedInput: { bodyText: "hi" },
      status: "approved",
    });
    const outcome = await loadBundleReview({
      ticketId: TICKET,
      token: reviewToken(),
      signingKey: SIGNING_KEY,
      layer: env.layer,
    });
    expect(outcome.kind).toBe("no_pending");
  });
});

describe("decideBundleFromLink", () => {
  it("approves every pending row and publishes ONE event", async () => {
    const env = makeEnv();
    const { reply, refund } = seedTwo(env);
    const publish = vi.fn(async (_e: DomainEvent) => {});

    const outcome = await decideBundleFromLink({
      ticketId: TICKET,
      action: "approve",
      token: reviewToken(),
      signingKey: SIGNING_KEY,
      layer: env.layer,
      publish,
    });

    expect(outcome.kind).toBe("decided");
    if (outcome.kind === "decided") {
      expect(outcome.decidedCount).toBe(2);
    }
    expect(env.store.get(reply.id)?.status).toBe("approved");
    expect(env.store.get(refund.id)?.status).toBe("approved");
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("rejects every pending row", async () => {
    const env = makeEnv();
    const { reply, refund } = seedTwo(env);
    const publish = vi.fn(async (_e: DomainEvent) => {});

    const outcome = await decideBundleFromLink({
      ticketId: TICKET,
      action: "reject",
      token: reviewToken(),
      signingKey: SIGNING_KEY,
      layer: env.layer,
      publish,
    });

    expect(outcome.kind).toBe("decided");
    expect(env.store.get(reply.id)?.status).toBe("rejected");
    expect(env.store.get(refund.id)?.status).toBe("rejected");
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when nothing is pending (idempotent double-submit)", async () => {
    const env = makeEnv();
    env.seed({
      tool: "conversation.reply",
      proposedInput: { bodyText: "hi" },
      status: "approved",
    });
    const publish = vi.fn(async (_e: DomainEvent) => {});
    const outcome = await decideBundleFromLink({
      ticketId: TICKET,
      action: "approve",
      token: reviewToken(),
      signingKey: SIGNING_KEY,
      layer: env.layer,
      publish,
    });
    expect(outcome.kind).toBe("no_pending");
    expect(publish).not.toHaveBeenCalled();
  });

  it("touches nothing on a bad token", async () => {
    const env = makeEnv();
    const { reply } = seedTwo(env);
    const publish = vi.fn(async (_e: DomainEvent) => {});
    const outcome = await decideBundleFromLink({
      ticketId: TICKET,
      action: "approve",
      token: "not-a-token",
      signingKey: SIGNING_KEY,
      layer: env.layer,
      publish,
    });
    expect(outcome.kind).toBe("bad_token");
    expect(env.store.get(reply.id)?.status).toBe("pending");
    expect(publish).not.toHaveBeenCalled();
  });
});

describe("bundle review page rendering", () => {
  const pageInput = (env: Env) => ({
    ticket: makeTicket(),
    pending: [...env.store.values()].filter((r) => r.status === "pending"),
    token: reviewToken(),
    dashboardBaseUrl: "https://dash.example.com" as string | null,
  });

  it("lists each action, POSTs the token, and links to the dashboard", () => {
    const env = makeEnv();
    seedTwo(env);
    const page = renderBundleReviewPage(pageInput(env));
    expect(page.status).toBe(200);
    expect(page.body).toContain("Reply to the customer");
    expect(page.body).toContain("23.50 EUR");
    expect(page.body).toContain("Hi Jane, your refund is on the way.");
    expect(page.body).toContain("jane@example.com");
    // Both decisions are confirm-POSTs carrying the token in the body.
    expect(page.body).toContain(`action="/approvals/bundle/${TICKET}/approve"`);
    expect(page.body).toContain(`action="/approvals/bundle/${TICKET}/reject"`);
    expect(page.body).toContain('name="token"');
    // Extra actions (edit a draft, decide per-action) live in the dashboard.
    expect(page.body).toContain("View on dashboard");
    expect(page.body).toContain(
      `https://dash.example.com/tickets/${TICKET}`,
    );
  });

  it("omits the dashboard link when no dashboard is deployed", () => {
    const env = makeEnv();
    seedTwo(env);
    const page = renderBundleReviewPage({
      ...pageInput(env),
      dashboardBaseUrl: null,
    });
    expect(page.body).not.toContain("View on dashboard");
  });

  it("escapes HTML in agent-authored draft text", () => {
    const env = makeEnv();
    env.seed({
      tool: "conversation.reply",
      proposedInput: { bodyText: '<script>alert("x")</script>' },
    });
    const page = renderBundleReviewPage(pageInput(env));
    expect(page.body).not.toContain("<script>alert");
    expect(page.body).toContain("&lt;script&gt;");
  });

  it("renders decision receipts and error pages", () => {
    const approved = renderBundleDecisionPage({
      kind: "decided",
      action: "approve",
      decidedCount: 2,
    });
    expect(approved.status).toBe(200);
    expect(approved.body).toContain("approved");

    const expired = renderBundleReviewErrorPage({
      kind: "bad_token",
      reason: "expired",
    });
    expect(expired.status).toBe(400);

    const missing = renderBundleReviewErrorPage({ kind: "ticket_not_found" });
    expect(missing.status).toBe(404);
  });

  it("receipts and expired links carry a small dashboard link when configured", () => {
    const opts = {
      ticketId: TICKET as string,
      dashboardBaseUrl: "https://dash.example.com" as string | null,
    };
    const approved = renderBundleDecisionPage(
      { kind: "decided", action: "approve", decidedCount: 2 },
      opts,
    );
    expect(approved.body).toContain("View on dashboard");
    expect(approved.body).toContain(
      `https://dash.example.com/tickets/${TICKET}`,
    );

    const already = renderBundleReviewErrorPage({ kind: "no_pending" }, opts);
    expect(already.body).toContain("View on dashboard");

    const expired = renderBundleReviewErrorPage(
      { kind: "bad_token", reason: "expired" },
      opts,
    );
    expect(expired.body).toContain(
      `https://dash.example.com/tickets/${TICKET}`,
    );

    // No dashboard configured → no link, no broken href.
    const bare = renderBundleDecisionPage({
      kind: "decided",
      action: "approve",
      decidedCount: 2,
    });
    expect(bare.body).not.toContain("View on dashboard");
  });
});
