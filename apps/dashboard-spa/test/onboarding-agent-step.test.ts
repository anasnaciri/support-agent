// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const api = vi.hoisted(() => ({
  catalog: vi.fn(), models: vi.fn(), agentOverrides: vi.fn(),
  setAgentModel: vi.fn(), clearAgentModel: vi.fn(),
  setAgentToolPermission: vi.fn(), clearAgentToolPermission: vi.fn(),
  setAgentSystemPrompt: vi.fn(), clearAgentSystemPrompt: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({ api }));
vi.mock("@/lib/session-context", () => ({ useWorkspaceCtx: () => ({ workspaceId: "w1" }) }));
vi.mock("sonner", () => ({ toast: { warning: vi.fn() } }));
const { AgentStep } = await import("../features/onboarding/steps/AgentStep");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let container: HTMLDivElement;
afterEach(() => { act(() => root.unmount()); container.remove(); vi.clearAllMocks(); });

describe("onboarding agent configuration", () => {
  it("persists the selected model and action permissions", async () => {
    api.catalog.mockResolvedValue({
      defaultModel: "model/default",
      agents: [{ id: "scenario-resolution-agent", name: "Support", description: "", mode: "primary", provider: "openrouter",
        model: "model/default", promptTemplate: "", tools: ["conversation.reply"], permissionOverrides: {}, handoffs: [], maxTurnsPerTick: 8, isCustom: false }],
      tools: [{ name: "conversation.reply", description: "", displayName: "Reply to the customer", risk: "write", defaultPermission: "ask",
        sideEffectClass: "external_write", tenantControl: "permission-toggle" }],
    });
    api.models.mockResolvedValue({ connected: true, provider: "openrouter", error: null,
      entries: [{ id: "model/default", name: "Default", family: "Test" }, { id: "model/fast", name: "Fast", family: "Test" }] });
    api.agentOverrides.mockResolvedValue([]);
    api.setAgentModel.mockResolvedValue({ status: 200, body: null });
    api.setAgentToolPermission.mockResolvedValue({ status: 200, body: null });
    api.setAgentSystemPrompt.mockResolvedValue({ status: 200, body: null });
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => { root.render(createElement(QueryClientProvider, { client }, createElement(AgentStep, { onDone: vi.fn(), canEdit: true }))); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    const model = container.querySelector<HTMLSelectElement>('[name="model"]')!;
    const permission = container.querySelector<HTMLSelectElement>('[name="permission:conversation.reply"]')!;
    const instructions = container.querySelector<HTMLTextAreaElement>('[name="systemPrompt"]')!;
    expect(model).not.toBeNull(); expect(permission).not.toBeNull(); expect(instructions).not.toBeNull();
    await act(async () => {
      model.value = "model/fast"; model.dispatchEvent(new Event("change", { bubbles: true }));
      permission.value = "allow"; permission.dispatchEvent(new Event("change", { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(instructions, "Keep replies warm and concise.");
      instructions.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Save and continue"))!.click());

    expect(api.setAgentModel).toHaveBeenCalledWith({ workspaceId: "w1" }, "scenario-resolution-agent", "model/fast");
    expect(api.setAgentToolPermission).toHaveBeenCalledWith({ workspaceId: "w1" }, "scenario-resolution-agent", "conversation.reply", "allow");
    expect(api.setAgentSystemPrompt).toHaveBeenCalledWith({ workspaceId: "w1" }, "scenario-resolution-agent", "Keep replies warm and concise.");
  });

  it("clears redundant overrides when the merchant restores defaults", async () => {
    api.catalog.mockResolvedValue({
      defaultModel: "model/default",
      agents: [{ id: "scenario-resolution-agent", name: "Support", description: "", mode: "primary", provider: "openrouter",
        model: "model/default", promptTemplate: "", tools: ["conversation.reply"], permissionOverrides: {}, handoffs: [], maxTurnsPerTick: 8, isCustom: false }],
      tools: [{ name: "conversation.reply", description: "", displayName: "Reply", risk: "write", defaultPermission: "ask",
        sideEffectClass: "external_write", tenantControl: "permission-toggle" }],
    });
    api.models.mockResolvedValue({ connected: true, provider: "openrouter", error: null,
      entries: [{ id: "model/default", name: "Default", family: "Test" }, { id: "model/fast", name: "Fast", family: "Test" }] });
    api.agentOverrides.mockResolvedValue([{ agentId: "scenario-resolution-agent", model: "model/fast", systemPrompt: null,
      toolPermissions: { "conversation.reply": "allow" } }]);
    api.clearAgentModel.mockResolvedValue({ status: 200, body: null });
    api.clearAgentToolPermission.mockResolvedValue({ status: 200, body: null });
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => { root.render(createElement(QueryClientProvider, { client }, createElement(AgentStep, { onDone: vi.fn(), canEdit: true }))); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const model = container.querySelector<HTMLSelectElement>('[name="model"]')!;
    const permission = container.querySelector<HTMLSelectElement>('[name="permission:conversation.reply"]')!;
    await act(async () => {
      model.value = ""; model.dispatchEvent(new Event("change", { bubbles: true }));
      permission.value = "ask"; permission.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Save and continue"))!.click());
    expect(api.clearAgentModel).toHaveBeenCalledWith({ workspaceId: "w1" }, "scenario-resolution-agent");
    expect(api.clearAgentToolPermission).toHaveBeenCalledWith({ workspaceId: "w1" }, "scenario-resolution-agent", "conversation.reply");
  });
});
