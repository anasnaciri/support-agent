// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ResolutionScenarioView } from "@support-agent/dashboard-contracts";

import { ScenarioCard } from "../features/settings/ScenariosPage";
import { fieldName } from "../lib/parse-resolution";

// The card is a pure api client; only the reference catalog is fetched.
vi.mock("@/lib/api-client", () => ({
  api: {
    factReferences: () =>
      Promise.resolve([
        {
          id: "refund.create",
          namespace: "actions",
          field: null,
          label: "Issue a refund",
          value: null,
        },
      ]),
    resolveFactReferences: () =>
      Promise.resolve({ resolved: "", dangling: [] }),
  },
}));

const scenario: ResolutionScenarioView = {
  key: "delivery_issue",
  label: "Delivery problem (lost / stuck / late)",
  recognition: "A shipped order is lost, stuck in transit, or very late.",
  builtin: true,
  enabled: true,
  enabledActions: [{ tool: "refund.create", permission: "ask" }],
  supplierMode: "escalate_and_wait",
  notes: "Once it is genuinely lost, make the customer whole with /refund.create.",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const mountCard = async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    root!.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ScenarioCard, {
          formKey: "delivery_issue",
          scenario,
          ctx: { workspaceId: "w1" },
        }),
      ),
    );
  });
};

const checkbox = (tool: string) =>
  container!.querySelector<HTMLInputElement>(
    `input[name="${fieldName("delivery_issue", `action:${tool}:enabled`)}"]`,
  )!;

const permissionSelect = (tool: string) =>
  container!.querySelector<HTMLSelectElement>(
    `select[name="${fieldName("delivery_issue", `action:${tool}:permission`)}"]`,
  )!;

const warningText = () =>
  [...container!.querySelectorAll("p")]
    .map((p) => p.textContent ?? "")
    .find((t) => t.toLowerCase().includes("turned off"));

// A real click, not an assigned `.checked` — React's value tracker ignores the
// latter, so only this exercises the onChange the card actually listens to.
const toggle = async (input: HTMLInputElement) => {
  await act(async () => {
    input.click();
  });
};

describe("per-scenario action switches", () => {
  it("offers the remedy actions, pre-checked from the saved policy", async () => {
    await mountCard();
    expect(checkbox("refund.create").checked).toBe(true);
    // Not enabled for this scenario, so unchecked and its approval choice moot.
    expect(checkbox("discount.create").checked).toBe(false);
    expect(permissionSelect("discount.create").disabled).toBe(true);
  });

  it("warns the playbook contradicts the switches the moment an action is turned off", async () => {
    // This is the whole point of putting the two on one screen: the note says to
    // refund, and the merchant has just told the agent it may not. The runtime
    // would silently strip the tool — here they see it immediately.
    await mountCard();
    expect(warningText()).toBeUndefined();

    await toggle(checkbox("refund.create"));

    expect(warningText()).toContain("Issue a refund");
    // Turning it back on clears the contradiction.
    await toggle(checkbox("refund.create"));
    expect(warningText()).toBeUndefined();
  });

  it("disables the approval choice for an action the agent may not take", async () => {
    await mountCard();
    expect(permissionSelect("refund.create").disabled).toBe(false);

    await toggle(checkbox("refund.create"));

    expect(permissionSelect("refund.create").disabled).toBe(true);
  });
});
