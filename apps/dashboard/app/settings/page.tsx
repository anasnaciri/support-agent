import Link from "next/link";
import { agents, tools } from "@/lib/catalog";

export default function SettingsLanding() {
  return (
    <>
      <h1>Settings</h1>
      <p className="muted">
        Configuration is currently read-only. Agents and tools live in code
        today; editing surfaces will land when configs move into per-tenant
        rows.
      </p>

      <div className="stat-grid">
        <Link href="/settings/agents" className="stat stat-link">
          <div className="label">Agents</div>
          <div className="value">{agents.length}</div>
          <div className="muted">
            Prompts, models, tools, and handoffs per agent.
          </div>
        </Link>
        <Link href="/settings/permissions" className="stat stat-link">
          <div className="label">Tool permissions</div>
          <div className="value">{tools.length}</div>
          <div className="muted">
            Allow / ask / deny per (agent, tool) pair.
          </div>
        </Link>
        <Link href="/settings/integrations" className="stat stat-link">
          <div className="label">Integrations</div>
          <div className="value">—</div>
          <div className="muted">
            Shopify and Gmail connection status for your tenant.
          </div>
        </Link>
      </div>
    </>
  );
}
