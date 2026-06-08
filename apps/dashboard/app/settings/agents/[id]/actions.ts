"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { api, getDashboardContext } from "@/lib/api-client";
import { findAgent } from "@/lib/catalog";

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
