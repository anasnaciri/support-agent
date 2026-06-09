"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { api, getDashboardContext } from "@/lib/api-client";
import { findAgent, findTool, effectivePermission } from "@/lib/catalog";

export const setAgentModelAction = async (
  formData: FormData,
): Promise<void> => {
  const ctx = await getDashboardContext();

  const agentIdRaw = formData.get("agentId");
  const modelRaw = formData.get("model");
  const agentId = typeof agentIdRaw === "string" ? agentIdRaw.trim() : "";
  const model = typeof modelRaw === "string" ? modelRaw.trim() : "";

  if (!agentId) redirect("/settings/agents");
  // Catalog-side guard: only set an override for an agent that exists, and
  // treat re-selecting the agent default (or an empty pick) as a clear.
  const catalog = await api.catalog(ctx);
  const agent = findAgent(catalog, agentId);
  if (!agent) redirect("/settings/agents");

  if (model === "" || model === agent.model) {
    await api.clearAgentModel(ctx, agentId);
  } else {
    await api.setAgentModel(ctx, agentId, model);
  }

  revalidatePath(`/settings/agents/${agentId}`);
  revalidatePath("/settings/agents");
  redirect(
    `/settings/agents/${encodeURIComponent(agentId)}?model=${model === "" || model === agent.model ? "reset" : "updated"}`,
  );
};

export const clearAgentModelAction = async (
  formData: FormData,
): Promise<void> => {
  const ctx = await getDashboardContext();

  const agentIdRaw = formData.get("agentId");
  const agentId = typeof agentIdRaw === "string" ? agentIdRaw.trim() : "";
  if (!agentId) redirect("/settings/agents");

  await api.clearAgentModel(ctx, agentId);

  revalidatePath(`/settings/agents/${agentId}`);
  revalidatePath("/settings/agents");
  redirect(`/settings/agents/${encodeURIComponent(agentId)}?model=reset`);
};

export const setAgentSystemPromptAction = async (
  formData: FormData,
): Promise<void> => {
  const ctx = await getDashboardContext();

  const agentIdRaw = formData.get("agentId");
  const promptRaw = formData.get("systemPrompt");
  const agentId = typeof agentIdRaw === "string" ? agentIdRaw.trim() : "";
  const systemPrompt = typeof promptRaw === "string" ? promptRaw.trim() : "";

  if (!agentId) redirect("/settings/agents");
  // Catalog-side guard: only touch overrides for an agent that exists.
  const catalog = await api.catalog(ctx);
  const agent = findAgent(catalog, agentId);
  if (!agent) redirect("/settings/agents");

  // Saving an empty prompt reverts to the built-in prompt (the api treats a
  // blank body as a clear too; we mirror it here so the banner reads "reset").
  if (systemPrompt === "") {
    await api.clearAgentSystemPrompt(ctx, agentId);
  } else {
    await api.setAgentSystemPrompt(ctx, agentId, systemPrompt);
  }

  revalidatePath(`/settings/agents/${agentId}`);
  redirect(
    `/settings/agents/${encodeURIComponent(agentId)}?prompt=${systemPrompt === "" ? "reset" : "updated"}`,
  );
};

export const clearAgentSystemPromptAction = async (
  formData: FormData,
): Promise<void> => {
  const ctx = await getDashboardContext();

  const agentIdRaw = formData.get("agentId");
  const agentId = typeof agentIdRaw === "string" ? agentIdRaw.trim() : "";
  if (!agentId) redirect("/settings/agents");

  await api.clearAgentSystemPrompt(ctx, agentId);

  revalidatePath(`/settings/agents/${agentId}`);
  redirect(`/settings/agents/${encodeURIComponent(agentId)}?prompt=reset`);
};

// Set a per-agent tool permission from the Actions card's Ask/Auto toggle.
// Mirrors setAgentModelAction's "re-selecting the default is a clear" rule: if
// the chosen value equals the agent's default for that tool, we drop the
// override instead of storing a redundant row.
export const setAgentToolPermissionAction = async (
  formData: FormData,
): Promise<void> => {
  const ctx = await getDashboardContext();

  const agentIdRaw = formData.get("agentId");
  const toolRaw = formData.get("tool");
  const permissionRaw = formData.get("permission");
  const agentId = typeof agentIdRaw === "string" ? agentIdRaw.trim() : "";
  const tool = typeof toolRaw === "string" ? toolRaw.trim() : "";
  const permission =
    typeof permissionRaw === "string" ? permissionRaw.trim() : "";

  if (!agentId) redirect("/settings/agents");
  const agentPath = `/settings/agents/${encodeURIComponent(agentId)}`;
  // Only ask|allow are tenant-settable; "deny" stays a policy outcome.
  if (permission !== "ask" && permission !== "allow") redirect(agentPath);

  // Catalog-side guard: the agent must exist and the tool must be one of its
  // bound, toggle-controlled actions (refund.create is threshold-controlled,
  // not a toggle, so it's rejected here too).
  const catalog = await api.catalog(ctx);
  const agent = findAgent(catalog, agentId);
  if (!agent) redirect("/settings/agents");
  const toolDef = findTool(catalog, tool);
  if (
    !toolDef ||
    toolDef.tenantControl !== "permission-toggle" ||
    !agent.tools.includes(tool)
  ) {
    redirect(agentPath);
  }

  const agentDefault = effectivePermission(agent, catalog, tool);
  if (permission === agentDefault) {
    await api.clearAgentToolPermission(ctx, agentId, tool);
  } else {
    await api.setAgentToolPermission(ctx, agentId, tool, permission);
  }

  revalidatePath(agentPath);
  redirect(`${agentPath}?perm=updated`);
};
