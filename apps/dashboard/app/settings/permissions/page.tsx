import Link from "next/link";
import { agents, tools, effectivePermission } from "@/lib/catalog";
import type { Permission } from "@support-agent/agent-core";

// Permissions matrix — one row per tool, one column per agent. Cell
// shows the effective permission: the agent's `permissionOverrides`
// entry if present, otherwise the tool's `defaultPermission`. Cells
// for tools the agent doesn't have in its `tools` list show "—".

const cell = (
  agentTools: ReadonlyArray<string>,
  perm: Permission | null,
  toolName: string,
): { readonly className: string; readonly text: string } => {
  if (!agentTools.includes(toolName)) {
    return { className: "perm-na", text: "—" };
  }
  if (!perm) return { className: "perm-na", text: "?" };
  return { className: `perm-${perm}`, text: perm };
};

export default function PermissionsMatrixPage() {
  return (
    <>
      <p className="muted">
        <Link href="/settings">← Settings</Link>
      </p>
      <h1>Tool permissions</h1>
      <p className="muted">
        Effective permission per (agent, tool). <code>ask</code> tools pause
        the case in <code>waiting_for_approval</code> until a human approves
        via the approval surface.
      </p>

      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>Tool</th>
              <th>Default</th>
              {agents.map((a) => (
                <th key={a.id}>
                  <Link href={`/settings/agents/${a.id}`}>{a.name}</Link>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tools.map((t) => (
              <tr key={t.name}>
                <td>
                  <code>{t.name}</code>
                  <div className="muted">{t.description}</div>
                </td>
                <td>
                  <span className={`badge perm-${t.defaultPermission}`}>
                    {t.defaultPermission}
                  </span>
                </td>
                {agents.map((a) => {
                  const eff = effectivePermission(a, t.name);
                  const c = cell(a.tools, eff, t.name);
                  return (
                    <td key={a.id}>
                      <span className={`badge ${c.className}`}>{c.text}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
