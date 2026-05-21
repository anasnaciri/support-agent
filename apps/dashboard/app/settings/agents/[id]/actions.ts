"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Effect, Layer } from "effect";
import {
  DbClientLive,
  TenantAgentOverridesServiceLive,
} from "@support-agent/db";
import { TenantAgentOverridesService } from "@support-agent/services";
import { AgentId, TenantId } from "@support-agent/agent-core";
import { findAgent } from "@/lib/catalog";
import { getTenantId } from "@/lib/tenant";

const overridesLayer = () => {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const db = DbClientLive({ databaseUrl });
  return TenantAgentOverridesServiceLive.pipe(Layer.provide(db));
};

export const setAgentModelAction = async (
  formData: FormData,
): Promise<void> => {
  const tenantId = await getTenantId();
  const tid = TenantId(tenantId);

  const agentIdRaw = formData.get("agentId");
  const modelRaw = formData.get("model");
  const agentId =
    typeof agentIdRaw === "string" ? agentIdRaw.trim() : "";
  const model = typeof modelRaw === "string" ? modelRaw.trim() : "";

  if (!agentId) redirect("/settings/agents");
  // Catalog-side guard: only allow setting an override for an agent that
  // actually exists in the in-code registry. Prevents stale form submits
  // from materializing dead override rows.
  const agent = findAgent(agentId);
  if (!agent) redirect("/settings/agents");

  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const svc = yield* TenantAgentOverridesService;
        if (model === "" || model === agent.model) {
          // Empty pick OR default re-selected → clear override row so the
          // tenant rolls back to the AgentConfig default cleanly.
          yield* svc.clearModel(tid, AgentId(agentId));
        } else {
          yield* svc.setModel(tid, AgentId(agentId), model);
        }
      }),
      overridesLayer(),
    ).pipe(Effect.scoped),
  );

  revalidatePath(`/settings/agents/${agentId}`);
  revalidatePath("/settings/agents");
  redirect(
    `/settings/agents/${encodeURIComponent(agentId)}?model=${model === "" || model === agent.model ? "reset" : "updated"}`,
  );
};

export const clearAgentModelAction = async (
  formData: FormData,
): Promise<void> => {
  const tenantId = await getTenantId();
  const tid = TenantId(tenantId);

  const agentIdRaw = formData.get("agentId");
  const agentId =
    typeof agentIdRaw === "string" ? agentIdRaw.trim() : "";
  if (!agentId) redirect("/settings/agents");

  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const svc = yield* TenantAgentOverridesService;
        yield* svc.clearModel(tid, AgentId(agentId));
      }),
      overridesLayer(),
    ).pipe(Effect.scoped),
  );

  revalidatePath(`/settings/agents/${agentId}`);
  revalidatePath("/settings/agents");
  redirect(
    `/settings/agents/${encodeURIComponent(agentId)}?model=reset`,
  );
};
