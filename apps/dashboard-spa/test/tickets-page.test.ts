// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type AnchorHTMLAttributes } from "react";
import { createRoot, type Root } from "react-dom/client";

const { useQuery } = vi.hoisted(() => ({ useQuery: vi.fn() }));

vi.mock("@tanstack/react-query", () => ({ useQuery }));
vi.mock("@/lib/session-context", () => ({
  useWorkspaceCtx: () => ({ workspaceId: "w1" }),
}));
vi.mock("@/components/ui/link", () => ({
  Link: ({ children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) =>
    createElement("a", props, children),
}));

const { TicketsPage } = await import("../features/tickets/TicketsPage");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("tickets page", () => {
  it("does not show the assigned agent in the tickets table", () => {
    useQuery.mockReturnValue({
      data: {
        rows: [
          {
            id: "ticket-1",
            subject: "Where is my order?",
            status: "open",
            scenarioKey: "delivery_issue",
            currentAgentId: "support-agent",
            waitingOn: [],
            updatedAt: "2026-07-14T10:00:00.000Z",
          },
        ],
        totalRows: 1,
      },
      isLoading: false,
      isError: false,
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root.render(createElement(TicketsPage));
    });

    const headings = [...container.querySelectorAll("th")].map((heading) =>
      heading.textContent?.trim(),
    );
    expect(headings).toEqual(["Subject", "Status", "Category", "Updated"]);
    expect(container.textContent).not.toContain("support-agent");
  });
});
