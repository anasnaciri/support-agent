// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { resolutionPolicy } = vi.hoisted(() => ({
  resolutionPolicy: vi.fn(),
}));

vi.mock("@/lib/api-client", () => ({
  api: { resolutionPolicy },
}));

vi.mock("@/lib/session-context", () => ({
  useWorkspaceCtx: () => ({ workspaceId: "w1" }),
}));

vi.mock("@/components/ui/link", () => ({
  Link: ({ children, href, ...props }: ComponentProps<"a">) =>
    createElement("a", { href, ...props }, children),
}));

const { ScenariosStep } = await import(
  "../features/onboarding/steps/ScenariosStep"
);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;

const mount = async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ScenariosStep, { onDone: vi.fn(), canEdit: true }),
      ),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const scenarioButton = (label: string): HTMLButtonElement => {
  const button = [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (!button) throw new Error(`No scenario button for ${label}`);
  return button;
};

beforeEach(() => {
  resolutionPolicy.mockResolvedValue({
    scenarios: [
      {
        key: "delivery_issue",
        label: "Delivery problem",
        recognition: null,
        builtin: true,
        enabled: true,
        enabledActions: [{ tool: "refund.create", permission: "ask" }],
        fulfillmentOperatorMode: "escalate_and_wait",
        notes: "Confirm the parcel is genuinely lost before refunding.",
      },
      {
        key: "retention",
        label: "Keep a customer",
        recognition: null,
        builtin: true,
        enabled: true,
        enabledActions: [{ tool: "discount.create", permission: "allow" }],
        fulfillmentOperatorMode: "none",
        notes: "Offer a modest incentive when it can save the relationship.",
      },
    ],
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("onboarding scenario review", () => {
  it("expands and collapses scenario playbook notes and actions as an accordion", async () => {
    await mount();

    const delivery = scenarioButton("Delivery problem");
    expect(delivery.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("genuinely lost");

    await act(async () => delivery.click());
    expect(delivery.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain(
      "Confirm the parcel is genuinely lost before refunding.",
    );
    expect(container.textContent).toContain("Issue a refund");
    expect(container.textContent).toContain("Ask me first");

    const retention = scenarioButton("Keep a customer");
    await act(async () => retention.click());
    expect(delivery.getAttribute("aria-expanded")).toBe("false");
    expect(retention.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).not.toContain("genuinely lost");
    expect(container.textContent).toContain("Offer a modest incentive");
    expect(container.textContent).toContain("Issue a discount code");
    expect(container.textContent).toContain("Do it automatically");

    await act(async () => retention.click());
    expect(retention.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("Offer a modest incentive");
  });
});
