import Link from "next/link";
import { notFound } from "next/navigation";
import { Header, StatusBadge } from "@/app/_components/header";
import { SubmitButton } from "@/app/_components/submit-button";
import { adminApi } from "@/lib/admin-api";
import { requireSession } from "@/lib/session";
import {
  revokeAccountOpenRouterAction,
  setAccountOpenRouterAction,
} from "./actions";

export const dynamic = "force-dynamic";

interface PageProps {
  readonly params: Promise<{ readonly organizationId: string }>;
  readonly searchParams?: Promise<
    Readonly<Record<string, string | string[] | undefined>>
  >;
}

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

export default async function AccountPage({ params, searchParams }: PageProps) {
  await requireSession();
  const { organizationId } = await params;
  const detail = await adminApi.accountDetail(organizationId);
  if (!detail) notFound();
  const sp = (await searchParams) ?? {};
  const ok = first(sp["ok"]);
  const error = first(sp["error"]);
  const setKey = setAccountOpenRouterAction.bind(null, organizationId);
  const revoke = revokeAccountOpenRouterAction.bind(null, organizationId);

  return (
    <>
      <Header crumb={detail.organizationName ?? organizationId} />
      <main className="mx-auto max-w-3xl space-y-8 px-6 py-8">
        {ok ? (
          <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
            {ok === "openrouter_revoked"
              ? "Account OpenRouter key revoked."
              : "Account OpenRouter key saved."}
          </p>
        ) : null}
        {error ? (
          <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error === "legal_acceptance_required"
              ? "Every workspace must accept the current legal notice and DPA before an account key can be enabled."
              : error === "missing_key"
                ? "Paste the full OpenRouter API key."
                : "The OpenRouter credential change failed."}
          </p>
        ) : null}

        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {detail.organizationName ?? "Account"}
          </h1>
          <p className="mt-2 font-mono text-sm text-zinc-400">
            {organizationId}
          </p>
        </div>

        <section className="space-y-4 rounded-lg border border-zinc-800 p-5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-medium">Inherited OpenRouter key</h2>
              <p className="mt-1 text-sm text-zinc-400">
                Used by every current and future workspace unless that workspace
                has its own LLM override.
              </p>
            </div>
            <StatusBadge status={detail.openrouter?.status ?? null} />
          </div>
          {detail.openrouter ? (
            <p className="text-xs text-zinc-500">
              Updated {new Date(detail.openrouter.updatedAt).toLocaleString()}
            </p>
          ) : null}
          <form action={setKey} className="space-y-3">
            <label htmlFor="apiKey" className="block text-sm text-zinc-300">
              OpenRouter API key
            </label>
            <input
              id="apiKey"
              name="apiKey"
              type="password"
              required
              autoComplete="off"
              placeholder={detail.openrouter ? "•••••• (re-enter to rotate)" : "sk-or-v1-…"}
              className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-sm outline-none focus:border-zinc-500"
            />
            <SubmitButton
              pendingLabel="Saving…"
              className="rounded-md bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 hover:bg-white"
            >
              {detail.openrouter ? "Rotate account key" : "Set account key"}
            </SubmitButton>
          </form>
          {detail.openrouter?.status === "active" ? (
            <form action={revoke} className="border-t border-zinc-800 pt-3">
              <SubmitButton
                pendingLabel="Revoking…"
                className="text-sm text-red-400 hover:text-red-300"
              >
                Revoke account key
              </SubmitButton>
            </form>
          ) : null}
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-medium">Workspaces</h2>
          <div className="overflow-hidden rounded-lg border border-zinc-800">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-zinc-800">
                {detail.workspaces.map((workspace) => (
                  <tr key={workspace.id}>
                    <td className="px-4 py-3">
                      <div>{workspace.name}</div>
                      <div className="font-mono text-xs text-zinc-500">
                        {workspace.id}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/tenants/${workspace.id}`}
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
        </section>
      </main>
    </>
  );
}
