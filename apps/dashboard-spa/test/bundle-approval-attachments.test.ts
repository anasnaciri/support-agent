import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ApprovalDetail } from "@support-agent/dashboard-contracts";

import { BundleApprovalBar } from "../features/tickets/BundleApprovalBar";
import { qk } from "../lib/query-keys";

const approval = (
  overrides: Partial<ApprovalDetail> = {},
): ApprovalDetail => ({
  id: "approval-reply",
  ticketId: "ticket-1",
  agentId: "scenario-resolution-agent",
  tool: "conversation.reply",
  proposedInput: {
    threadId: "thread-1",
    bodyText: "Here is the label.",
    attachmentIds: [],
  },
  approvedInput: null,
  reasoning: null,
  riskLevel: "low",
  status: "pending",
  decidedBy: null,
  decidedAt: null,
  decisionReason: null,
  expiresAt: "2026-07-10T00:00:00.000Z",
  createdAt: "2026-07-09T00:00:00.000Z",
  ...overrides,
});

describe("BundleApprovalBar attachments", () => {
  it("offers attachment controls on bundled reply approvals", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    client.setQueryData(qk.ticketAttachments("workspace-1", "ticket-1"), {
      attachments: [
        {
          id: "att-1",
          source: "fulfillment_operator",
          filename: "return-label.pdf",
          contentType: "application/pdf",
          sizeBytes: 1234,
          uploadedBy: null,
          escalationId: null,
          messageId: null,
          usedAt: null,
          createdAt: "2026-07-09T00:00:00.000Z",
        },
      ],
    });

    const html = renderToStaticMarkup(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(BundleApprovalBar, {
          workspaceId: "workspace-1",
          ticketId: "ticket-1",
          pending: [
            approval(),
            approval({ id: "approval-refund", tool: "refund.create" }),
          ],
        }),
      ),
    );

    expect(html).toContain("Attach");
    expect(html).toContain("Ticket files");
  });
});
