import Link from "next/link";

import { adminApi } from "@/lib/admin-api";
import { requireSession } from "@/lib/session";
import { Header, StatusBadge } from "./_components/header";

export const dynamic = "force-dynamic";

export default async function TenantsPage() {
  await requireSession();
  const tenants = await adminApi.listTenants();

  return (
    <>
      <Header />
      <main className="mx-auto max-w-5xl px-6 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">Tenants</h1>
          <p className="mt-1 text-sm text-zinc-400">
            {tenants.length} tenant{tenants.length === 1 ? "" : "s"}. Open one to
            provision its Shopify custom app, inspect connectors, or delete it.
          </p>
        </div>

        {tenants.length === 0 ? (
          <p className="rounded-md border border-zinc-800 px-4 py-8 text-center text-sm text-zinc-400">
            No tenants yet.
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-900/60 text-left text-xs uppercase tracking-wide text-zinc-400">
                <tr>
                  <th className="px-4 py-3 font-medium">Tenant</th>
                  <th className="px-4 py-3 font-medium">Shopify app</th>
                  <th className="px-4 py-3 font-medium">Connectors</th>
                  <th className="px-4 py-3 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {tenants.map((t) => (
                  <tr key={t.id} className="hover:bg-zinc-900/40">
                    <td className="px-4 py-3">
                      <div className="font-medium">{t.name}</div>
                      <div className="font-mono text-xs text-zinc-500">
                        {t.id}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={t.shopifyApp.status} />
                    </td>
                    <td className="px-4 py-3 text-zinc-300">
                      {t.connectionCount}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/tenants/${t.id}`}
                        className="text-zinc-300 hover:text-white hover:underline"
                      >
                        Manage →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </>
  );
}
