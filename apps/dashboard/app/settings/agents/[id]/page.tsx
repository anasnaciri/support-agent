import Link from "next/link";
import { notFound } from "next/navigation";
import { findAgent, findTool, effectivePermission } from "@/lib/catalog";

interface Props {
  readonly params: Promise<{ readonly id: string }>;
}

export default async function AgentDetailPage({ params }: Props) {
  const { id } = await params;
  const agent = findAgent(id);
  if (!agent) notFound();

  return (
    <>
      <p className="muted">
        <Link href="/settings/agents">← Agents</Link>
      </p>
      <h1>{agent.name}</h1>
      <p className="muted">
        <code>{agent.id}</code> · <span className={`badge ${agent.mode}`}>{agent.mode}</span>
      </p>

      <p>{agent.description}</p>

      <dl className="panel-grid" style={{ marginBottom: 16 }}>
        <dt>Model</dt>
        <dd>
          <code>{agent.provider}:{agent.model}</code>
        </dd>
        {agent.fallback ? (
          <>
            <dt>Fallback</dt>
            <dd>
              <code>{agent.fallback.provider}:{agent.fallback.model}</code>
            </dd>
          </>
        ) : null}
        <dt>Max turns / tick</dt>
        <dd>{agent.maxTurnsPerTick}</dd>
        {agent.temperature !== undefined ? (
          <>
            <dt>Temperature</dt>
            <dd>{agent.temperature}</dd>
          </>
        ) : null}
      </dl>

      <h2>Tools</h2>
      <table>
        <thead>
          <tr>
            <th>Tool</th>
            <th>Description</th>
            <th>Permission</th>
          </tr>
        </thead>
        <tbody>
          {agent.tools.map((toolName) => {
            const tool = findTool(toolName);
            const perm = effectivePermission(agent, toolName);
            const overridden =
              agent.permissionOverrides[toolName] !== undefined;
            return (
              <tr key={toolName}>
                <td>
                  <code>{toolName}</code>
                  {!tool ? (
                    <div className="muted">(not in catalog)</div>
                  ) : null}
                </td>
                <td>{tool?.description ?? "—"}</td>
                <td>
                  {perm ? (
                    <span className={`badge perm-${perm}`}>{perm}</span>
                  ) : (
                    "—"
                  )}
                  {overridden ? (
                    <div className="muted">overridden</div>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {agent.handoffs.length > 0 ? (
        <>
          <h2>Handoffs</h2>
          <ul>
            {agent.handoffs.map((target) => (
              <li key={target}>
                <Link href={`/settings/agents/${target}`}>
                  <code>{target}</code>
                </Link>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <h2>Prompt</h2>
      <pre
        style={{
          background: "#fafafa",
          padding: 12,
          borderRadius: 6,
          fontSize: 13,
          whiteSpace: "pre-wrap",
          maxHeight: 400,
          overflow: "auto",
        }}
      >
        {agent.promptTemplate}
      </pre>
    </>
  );
}
