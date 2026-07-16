// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const { useQuery } = vi.hoisted(() => ({ useQuery: vi.fn() }));

vi.mock("@tanstack/react-query", () => ({ useQuery }));
vi.mock("@/lib/session-context", () => ({
  useWorkspaceCtx: () => ({ workspaceId: "workspace-1" }),
}));

const { AnalyticsPage } = await import(
  "../features/analytics/AnalyticsPage"
);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const period = {
  start: "2026-06-16T12:00:00.000Z",
  end: "2026-07-16T12:00:00.000Z",
  timezone: "UTC" as const,
};

let container: HTMLDivElement;
let root: Root;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("analytics page", () => {
  it("surfaces support outcomes and delivery health with their denominators", () => {
    useQuery.mockImplementation(
      ({ queryKey }: { readonly queryKey: readonly unknown[] }) =>
        queryKey[0] === "support-analytics"
          ? {
              data: {
                period,
                cohort: {
                  ticketsCreated: 80,
                  resolutionRate: { count: 60, total: 80, percentage: 75 },
                  handoffRate: { count: 12, total: 80, percentage: 15 },
                  handoffs: {
                    merchantTakeovers: 7,
                    automaticEscalations: 5,
                  },
                  resolutionOwnership: {
                    agentAssisted: 48,
                    humanHandled: 12,
                    unresolved: 20,
                  },
                  topScenarios: [
                    {
                      scenarioKey: "order_status",
                      count: 32,
                      percentage: 40,
                    },
                  ],
                  unclassifiedTickets: 4,
                },
                activity: {
                  ticketsResolved: 63,
                  medianFirstResponseMinutes: 4,
                  medianResolutionMinutes: 150,
                  medianApprovalWaitMinutes: 42,
                  drafts: {
                    decided: 40,
                    accepted: { count: 34, total: 40, percentage: 85 },
                    acceptedWithoutEdit: 25,
                    acceptedWithoutEditRate: {
                      count: 25,
                      total: 40,
                      percentage: 62.5,
                    },
                    editedThenAccepted: 9,
                    editedThenAcceptedRate: {
                      count: 9,
                      total: 40,
                      percentage: 22.5,
                    },
                    declined: 6,
                    declinedRate: {
                      count: 6,
                      total: 40,
                      percentage: 15,
                    },
                  },
                  refunds: {
                    total: 5,
                    issuedByAgent: 4,
                    issuedByHuman: 1,
                    valueByCurrency: [
                      { currencyCode: "USD", amountMinorUnits: 12_500 },
                    ],
                  },
                  customerReplyDeliveries: { failed: 2, abandoned: 1 },
                },
                backlog: {
                  total: 20,
                  byStatus: [{ status: "waiting_for_customer", count: 11 }],
                },
              },
              isLoading: false,
              isError: false,
            }
          : {
              data: {
                period,
                cohort: {
                  shipmentsCreated: 50,
                  deliveryRate: { count: 42, total: 50, percentage: 84 },
                  exceptionRate: { count: 5, total: 50, percentage: 10 },
                  exceptionRecoveryRate: {
                    count: 3,
                    total: 5,
                    percentage: 60,
                  },
                  topCarriers: [
                    {
                      carrier: "DHL",
                      shipments: 20,
                      exceptions: 2,
                      exceptionRate: {
                        count: 2,
                        total: 20,
                        percentage: 10,
                      },
                    },
                  ],
                },
                activity: {
                  delivered: 44,
                  exceptions: 6,
                  trackingStopped: 1,
                  medianTransitDays: 3.5,
                },
                current: {
                  total: 64,
                  inTransit: 14,
                  pending: 3,
                  exceptions: 4,
                  stopped: 1,
                  delivered: 42,
                },
              },
              isLoading: false,
              isError: false,
            },
    );

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root.render(createElement(AnalyticsPage));
    });

    expect(container.textContent).toContain("Analytics");
    expect(container.textContent).toContain("75%");
    expect(container.textContent).toContain("60 of 80 tickets");
    expect(container.textContent).toContain("Order status");
    expect(container.textContent).toContain("85%");
    expect(container.textContent).toContain("34 of 40 decided drafts");
    expect(container.textContent).toContain("14 in transit");
    expect(container.textContent).toContain("84%");
    expect(container.textContent).toContain("42 of 50 shipments");
    expect(container.textContent).toContain("$125.00");
    expect(container.textContent).toContain("DHL");
    expect(container.textContent).toContain("Waiting for customer");
    expect(container.textContent).toContain("44 delivered during period");
  });
});
