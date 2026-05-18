import Link from "next/link";
import { agents } from "@/lib/catalog";

export default function AgentsListPage() {
  return (
    <>
      <p className="muted">
        <Link href="/settings">← Settings</Link>
      </p>
      <h1>Agents</h1>
      <p className="muted">
        {agents.length} agent{agents.length === 1 ? "" : "s"} registered in
        the worker.
      </p>

      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Mode</th>
            <th>Model</th>
            <th>Tools</th>
            <th>Handoffs</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => (
            <tr key={a.id}>
              <td>
                <Link href={`/settings/agents/${a.id}`}>{a.name}</Link>
                <div className="muted">
                  <code>{a.id}</code>
                </div>
              </td>
              <td>
                <span className={`badge ${a.mode}`}>{a.mode}</span>
              </td>
              <td>
                <code>{a.provider}:{a.model}</code>
              </td>
              <td>{a.tools.length}</td>
              <td>{a.handoffs.length === 0 ? "—" : a.handoffs.length}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
