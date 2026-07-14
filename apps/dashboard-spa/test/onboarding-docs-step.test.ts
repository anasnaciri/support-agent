// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { knowledge, deleteKnowledge } = vi.hoisted(() => ({
  knowledge: vi.fn(),
  deleteKnowledge: vi.fn(),
}));

vi.mock("@/lib/api-client", () => ({ api: { knowledge, deleteKnowledge } }));
vi.mock("@/lib/session-context", () => ({
  useWorkspaceCtx: () => ({ workspaceId: "w1" }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn() } }));
vi.mock("@/features/tickets/ConfirmButton", () => ({
  ConfirmButton: ({ children, onConfirm }: { children: ReactNode; onConfirm: () => void }) =>
    createElement("button", { onClick: onConfirm }, children),
}));

const { DocsStep } = await import("../features/onboarding/steps/DocsStep");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("onboarding document review", () => {
  it("lets an authorised merchant delete an imported document", async () => {
    knowledge.mockResolvedValue([
      {
        id: "doc_1",
        title: "Old returns page",
        sourceType: "url",
        sourceUrl: "https://example.com/returns",
        fetchedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    deleteKnowledge.mockResolvedValue({ status: 200, body: null });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(DocsStep, { onDone: vi.fn(), canEdit: true }),
        ),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const button = [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes("Delete"),
    );
    expect(button).toBeDefined();
    await act(async () => button!.click());

    expect(deleteKnowledge).toHaveBeenCalledWith({ workspaceId: "w1" }, "doc_1");
  });
});
