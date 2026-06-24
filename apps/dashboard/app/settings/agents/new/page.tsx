import { api } from "@/lib/api-client";
import { requirePermission } from "@/lib/require-permission";
import { assignableTools } from "@/lib/catalog";
import { SettingsBreadcrumb } from "@/app/settings/_components/settings-breadcrumb";
import { AgentForm } from "../_components/agent-form";

const DEFAULT_MODEL = "google/gemini-3.5-flash";

interface Props {
  readonly searchParams?: Promise<
    Readonly<Record<string, string | string[] | undefined>>
  >;
}

export default async function NewAgentPage({ searchParams }: Props) {
  const ctx = await requirePermission("settings.agents");
  const [catalog, models] = await Promise.all([
    api.catalog(ctx),
    api.models(ctx),
  ]);
  const sp = (await searchParams) ?? {};
  const error = Array.isArray(sp["error"]) ? sp["error"][0] : sp["error"];

  // Every existing agent (built-in + custom) is a possible handoff target.
  const handoffOptions = catalog.agents.map((a) => ({
    label: a.name,
    value: a.id,
  }));

  return (
    <div className="space-y-6">
      <SettingsBreadcrumb
        items={[{ href: "/settings/agents", label: "Agents" }]}
        current="New agent"
      />
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">New agent</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Build a specialist that handles a specific kind of request. Existing
          agents can hand off to it once it&apos;s live.
        </p>
      </div>
      <AgentForm
        mode="create"
        assignable={assignableTools(catalog)}
        handoffOptions={handoffOptions}
        models={models.entries}
        defaultModel={DEFAULT_MODEL}
        providerConnected={models.connected}
        error={error ?? null}
      />
    </div>
  );
}
