// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { resolutionPolicy, setResolutionPolicy } = vi.hoisted(() => ({
  resolutionPolicy: vi.fn(),
  setResolutionPolicy: vi.fn(),
}));

vi.mock("@/lib/api-client", () => ({
  api: { resolutionPolicy, setResolutionPolicy },
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
  vi.clearAllMocks();
  setResolutionPolicy.mockResolvedValue({ status: 200, body: null });
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
      {
        key: "custom:wholesale",
        label: "Wholesale question",
        recognition: "A buyer asks about a bulk order.",
        builtin: false,
        enabled: true,
        enabledActions: [],
        fulfillmentOperatorMode: "none",
        notes: null,
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

  it("lets the merchant edit a playbook and persist the scenario configuration", async () => {
    await mount();
    await act(async () => scenarioButton("Delivery problem").click());

    const notes = container.querySelector<HTMLTextAreaElement>('[name="notes:delivery_issue"]')!;
    expect(notes).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        notes,
        "Verify tracking, then refund after approval.",
      );
      notes.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const permission = container.querySelector<HTMLSelectElement>('[name="permission:delivery_issue:refund.create"]')!;
    expect(permission).not.toBeNull();
    await act(async () => {
      permission.value = "allow";
      permission.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => scenarioButton("Save and continue").click());

    const saved = setResolutionPolicy.mock.calls[0]?.[1];
    expect(saved[0]).toMatchObject({
      key: "delivery_issue",
      notes: "Verify tracking, then refund after approval.",
      enabledActions: [{ tool: "refund.create", permission: "allow" }],
    });
  });

  it("lets the merchant edit a custom scenario's name and matching rule", async () => {
    await mount();
    await act(async () => scenarioButton("Wholesale question").click());
    const label = container.querySelector<HTMLInputElement>('[name="label:custom:wholesale"]')!;
    const recognition = container.querySelector<HTMLTextAreaElement>('[name="recognition:custom:wholesale"]')!;
    expect(label).not.toBeNull();
    expect(recognition).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        recognition,
        "A buyer asks for volume pricing or a bulk order.",
      );
      recognition.dispatchEvent(new Event("input", { bubbles: true }));
      recognition.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => scenarioButton("Save and continue").click());
    expect(setResolutionPolicy.mock.calls[0]?.[1][2]).toMatchObject({
      label: "Wholesale question",
      recognition: "A buyer asks for volume pricing or a bulk order.",
    });
  });

  it("configures active state, available actions, and fulfillment handling", async () => {
    await mount();
    await act(async () => scenarioButton("Delivery problem").click());
    const region = container.querySelector<HTMLElement>('[aria-label="Delivery problem playbook"]')!;
    const active = region.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const discountPermission = region.querySelector<HTMLSelectElement>('[name="permission:delivery_issue:discount.create"]')!;
    const discountEnabled = discountPermission.closest("li")!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const fulfillment = document.getElementById("fulfillment:delivery_issue") as HTMLSelectElement;
    await act(async () => {
      active.click();
      discountEnabled.click();
      fulfillment.value = "notify_and_proceed";
      fulfillment.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => scenarioButton("Save and continue").click());
    expect(setResolutionPolicy.mock.calls[0]?.[1][0]).toMatchObject({
      enabled: false,
      fulfillmentOperatorMode: "notify_and_proceed",
      enabledActions: [
        { tool: "refund.create", permission: "ask" },
        { tool: "discount.create", permission: "ask" },
      ],
    });
  });
});
