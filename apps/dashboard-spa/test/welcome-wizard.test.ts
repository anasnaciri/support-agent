// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OnboardingStateView } from "@support-agent/dashboard-contracts";

// Drives the wizard shell itself: the resume point it opens on, that Skip and
// Continue PERSIST (a wizard that forgets is worse than none — the merchant
// redoes work), that the last step finishes, and that "Set up later" leaves.
//
// The step bodies are stubbed: each one is a thin form over an endpoint that
// already has its own tests, and rendering eleven of them here would test
// TanStack Query, not the wizard.

const { state, advance, complete, dismiss, navReplace } = vi.hoisted(() => ({
  state: vi.fn(),
  advance: vi.fn(),
  complete: vi.fn(),
  dismiss: vi.fn(),
  navReplace: vi.fn(),
}));

vi.mock("@/lib/api-client", () => ({
  api: {
    onboardingState: state,
    onboardingAdvance: advance,
    onboardingComplete: complete,
    onboardingDismiss: dismiss,
    llmStatus: vi.fn().mockResolvedValue({ effective: { provider: "openrouter" } }),
    connections: vi.fn().mockResolvedValue([{ provider: "gmail", status: "active" }]),
  },
}));

vi.mock("@/lib/session-context", () => ({
  useWorkspaceCtx: () => ({ workspaceId: "w1" }),
  useSession: () => ({
    activeWorkspace: { id: "w1", name: "Acme" },
    permissions: new Set([
      "settings.integrations",
      "knowledge.manage",
      "settings.refund_policy",
      "settings.agents",
      "settings.llm",
      "settings.notifications",
      "members.manage",
    ]),
  }),
}));

vi.mock("@/lib/navigation", () => ({
  useAppNavigate: () => ({ replace: navReplace, push: vi.fn() }),
  usePathname: () => "/welcome",
}));

// Every step body is a stub that reports "done" when clicked, so the shell's
// own transitions are what's under test.
const stub = (label: string) => ({
  __esModule: true,
  ...Object.fromEntries([
    [
      label,
      ({ onDone }: { onDone: () => void }) =>
        createElement("button", { onClick: onDone }, `done:${label}`),
    ],
  ]),
});

vi.mock("@/features/onboarding/steps/StoreStep", () => stub("StoreStep"));
vi.mock("@/features/onboarding/steps/DocsStep", () => stub("DocsStep"));
vi.mock("@/features/onboarding/steps/FactsStep", () => stub("FactsStep"));
vi.mock("@/features/onboarding/steps/PoliciesStep", () => stub("PoliciesStep"));
vi.mock("@/features/onboarding/steps/ScenariosStep", () => stub("ScenariosStep"));
vi.mock("@/features/onboarding/steps/LlmStep", () => stub("LlmStep"));
vi.mock("@/features/onboarding/steps/AgentStep", () => stub("AgentStep"));
vi.mock("@/features/onboarding/steps/EmailStep", () => stub("EmailStep"));
vi.mock("@/features/onboarding/steps/TelegramStep", () => stub("TelegramStep"));
vi.mock("@/features/onboarding/steps/MembersStep", () => stub("MembersStep"));
vi.mock("@/features/onboarding/steps/PartnerStep", () => stub("PartnerStep"));

const { WelcomePage } = await import("../features/onboarding/WelcomePage");

const onboarding = (over: Partial<OnboardingStateView> = {}): OnboardingStateView => ({
  pending: true,
  steps: {},
  currentStep: null,
  completedAt: null,
  dismissedAt: null,
  ...over,
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;

const mount = async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(WelcomePage),
      ),
    );
  });
  // Let the onboarding-state query settle and the resume effect run, so tests
  // assert against the wizard rather than its loading spinner.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};

const click = async (text: string) => {
  const el = [...container.querySelectorAll("button, a")].find((n) =>
    n.textContent?.trim().startsWith(text),
  );
  if (!el) throw new Error(`no control matching "${text}"`);
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  advance.mockResolvedValue({ status: 200, body: {} });
  complete.mockResolvedValue({ status: 200, body: {} });
  dismiss.mockResolvedValue({ status: 200, body: {} });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("the setup wizard", () => {
  it("opens on the first step for a brand-new workspace", async () => {
    state.mockResolvedValue(onboarding());
    await mount();
    expect(container.textContent).toContain("Connect your store");
    expect(container.textContent).toContain("Step 1 of 11");
  });

  it("turns away a workspace that predates the wizard", async () => {
    // An old tenant has no onboarding state at all. The shell gate never sends
    // them here, but typing the URL used to render a wizard whose progress could
    // never persist (advance/complete are no-ops without a stamped state), so
    // the stepper stayed blank and a reload restarted them at step 1.
    state.mockResolvedValue(onboarding({ pending: false }));
    await mount();

    expect(navReplace).toHaveBeenCalledWith("/");
    expect(container.textContent).not.toContain("Connect your store");
  });

  it("turns away a merchant who already finished setup", async () => {
    state.mockResolvedValue(
      onboarding({ pending: false, completedAt: "2026-07-14T10:00:00.000Z" }),
    );
    await mount();
    expect(navReplace).toHaveBeenCalledWith("/");
  });

  it("turns away a merchant who chose 'Set up later'", async () => {
    state.mockResolvedValue(
      onboarding({ pending: false, dismissedAt: "2026-07-14T10:00:00.000Z" }),
    );
    await mount();
    expect(navReplace).toHaveBeenCalledWith("/");
  });

  it("resumes where the merchant left off", async () => {
    // The whole point of persisting a pointer: a merchant who comes back after
    // an OAuth round-trip, or the next morning, does not start over.
    state.mockResolvedValue(
      onboarding({ steps: { store: "done" }, currentStep: "facts" }),
    );
    await mount();
    expect(container.textContent).toContain("Shipping and returns");
    expect(container.textContent).toContain("Step 3 of 11");
  });

  it("records a finished step and moves to the next one", async () => {
    state.mockResolvedValue(onboarding());
    await mount();
    await click("done:StoreStep");

    expect(advance).toHaveBeenCalledWith(
      { workspaceId: "w1" },
      { step: "store", status: "done", nextStep: "docs" },
    );
    expect(container.textContent).toContain("Review your documents");
  });

  it("records a skip, and does not pretend it was done", async () => {
    state.mockResolvedValue(onboarding({ currentStep: "telegram" }));
    await mount();
    await click("Skip for now");

    expect(advance).toHaveBeenCalledWith(
      { workspaceId: "w1" },
      { step: "telegram", status: "skipped", nextStep: "members" },
    );
  });

  it("offers no skip on the step the product cannot run without", async () => {
    state.mockResolvedValue(onboarding({ currentStep: "store" }));
    await mount();
    const skip = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Skip"),
    );
    expect(skip).toBeUndefined();
  });

  it("finishes on the last step and leaves for the dashboard", async () => {
    state.mockResolvedValue(onboarding({ currentStep: "fulfillment_partner" }));
    await mount();
    await click("Finish setup");

    expect(complete).toHaveBeenCalled();
    expect(navReplace).toHaveBeenCalledWith("/");
  });

  it("lets the merchant leave early with 'Set up later'", async () => {
    state.mockResolvedValue(onboarding());
    await mount();
    await click("Set up later");

    expect(dismiss).toHaveBeenCalled();
    expect(navReplace).toHaveBeenCalledWith("/");
  });

  it("lets the merchant jump back to an earlier step from the rail", async () => {
    state.mockResolvedValue(
      onboarding({ steps: { store: "done" }, currentStep: "facts" }),
    );
    await mount();
    await click("Connect your store");

    expect(container.textContent).toContain("Step 1 of 11");
    // The jump is bookmarked too, so a reload keeps them where they went.
    expect(advance).toHaveBeenCalledWith(
      { workspaceId: "w1" },
      { nextStep: "store" },
    );
  });
});
