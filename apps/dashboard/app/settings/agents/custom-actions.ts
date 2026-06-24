"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { Permission } from "@support-agent/agent-core";
import type { CustomAgentWriteBody } from "@support-agent/dashboard-contracts";
import { api, getDashboardContext } from "@/lib/api-client";

// Build a CustomAgentWriteBody from the form. Tools + handoffs arrive as
// repeated keys (MultiSelect renders one hidden input per value); a per-tool
// approval choice arrives as `perm:<tool>` and is kept only for assigned,
// gated tools (read-only tools have no perm field → default automatic).
const parseForm = (formData: FormData): CustomAgentWriteBody => {
  const str = (k: string): string => {
    const v = formData.get(k);
    return typeof v === "string" ? v : "";
  };
  const list = (k: string): ReadonlyArray<string> =>
    formData.getAll(k).filter((v): v is string => typeof v === "string");

  const tools = list("tools");
  const permissionOverrides: Record<string, Permission> = {};
  for (const tool of tools) {
    const p = formData.get(`perm:${tool}`);
    if (p === "ask" || p === "allow") permissionOverrides[tool] = p;
  }

  const turnsRaw = Number(str("maxTurnsPerTick"));
  const maxTurnsPerTick = Number.isFinite(turnsRaw) && turnsRaw > 0 ? turnsRaw : 6;
  const status = str("status") === "disabled" ? "disabled" : "active";

  return {
    name: str("name").trim(),
    description: str("description").trim(),
    instructions: str("instructions"),
    model: str("model").trim() || "google/gemini-3.5-flash",
    tools,
    handoffs: list("handoffs"),
    callableFrom: list("callableFrom"),
    permissionOverrides,
    whenToUse: str("whenToUse").trim() || null,
    maxTurnsPerTick,
    status,
  };
};

export const createCustomAgentAction = async (
  formData: FormData,
): Promise<void> => {
  const ctx = await getDashboardContext();
  const body = parseForm(formData);
  const { status, body: resBody } = await api.createCustomAgent(ctx, body);
  if (status !== 200) {
    const error = (resBody as { error?: string } | null)?.error ?? "unknown";
    redirect(`/settings/agents/new?error=${encodeURIComponent(error)}`);
  }
  const created = resBody as { agentId: string };
  revalidatePath("/settings/agents");
  redirect(
    `/settings/agents/${encodeURIComponent(created.agentId)}?created=1`,
  );
};

export const updateCustomAgentAction = async (
  formData: FormData,
): Promise<void> => {
  const ctx = await getDashboardContext();
  const idRaw = formData.get("agentId");
  const agentId = typeof idRaw === "string" ? idRaw : "";
  if (!agentId) redirect("/settings/agents");
  const path = `/settings/agents/${encodeURIComponent(agentId)}`;
  const body = parseForm(formData);
  const { status, body: resBody } = await api.updateCustomAgent(
    ctx,
    agentId,
    body,
  );
  if (status === 404) redirect("/settings/agents");
  if (status !== 200) {
    const error = (resBody as { error?: string } | null)?.error ?? "unknown";
    redirect(`${path}?error=${encodeURIComponent(error)}`);
  }
  revalidatePath(path);
  revalidatePath("/settings/agents");
  redirect(`${path}?saved=1`);
};

export const deleteCustomAgentAction = async (
  formData: FormData,
): Promise<void> => {
  const ctx = await getDashboardContext();
  const idRaw = formData.get("agentId");
  const agentId = typeof idRaw === "string" ? idRaw : "";
  if (!agentId) redirect("/settings/agents");
  await api.deleteCustomAgent(ctx, agentId);
  revalidatePath("/settings/agents");
  redirect("/settings/agents?deleted=1");
};
