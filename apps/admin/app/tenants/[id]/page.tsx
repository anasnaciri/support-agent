import { notFound } from "next/navigation";

import { adminApi } from "@/lib/admin-api";
import { requireSession } from "@/lib/session";
import { Header, StatusBadge } from "@/app/_components/header";
import { SubmitButton } from "@/app/_components/submit-button";
import {
  provisionShopifyAppAction,
  revokeShopifyAppAction,
  runPcdCheckAction,
  revokeWorkspaceOpenRouterAction,
  setWorkspaceOpenRouterAction,
  deleteTenantAction,
} from "./actions";

export const dynamic = "force-dynamic";

const OK_MESSAGES: Record<string, string> = {
  shopify_saved: "Shopify app credentials saved.",
  shopify_revoked: "Shopify app provisioning revoked.",
  llm_saved: "Workspace OpenRouter override saved.",
  llm_revoked: "Workspace LLM override revoked; the account default now applies when available.",
};
const ERROR_MESSAGES: Record<string, string> = {
  missing_fields: "Client ID and secret are both required.",
  provision_failed: "Saving the credentials failed. Try again.",
  invalid_shop: "Store domain must be a valid *.myshopify.com domain.",
  shop_domain_required:
    "Store domain is required for a pilot install — enter the *.myshopify.com store this app is for.",
  shop_conflict: "That store is already connected to another tenant.",
  revoke_failed: "Revoking failed. Try again.",
  tenant_not_found: "Tenant not found.",
  name_mismatch: "The typed name didn't match — tenant not deleted.",
  delete_failed: "Deleting the tenant failed.",
  missing_llm_key: "Paste the full OpenRouter API key.",
  legal_acceptance_required:
    "This workspace must accept the current legal notice and DPA before an LLM key can be enabled.",
  llm_save_failed: "Saving the workspace OpenRouter override failed.",
  llm_revoke_failed: "Revoking the workspace LLM override failed.",
};

type Tone = "ok" | "warn" | "err";
const PCD_MESSAGES: Record<string, { tone: Tone; text: string }> = {
  present: {
    tone: "ok",
    text: "PCD check passed — recent orders return customer email/name/address. Protected customer data is flowing.",
  },
  redacted: {
    tone: "warn",
    text: "PCD check: recent orders came back with customer PII blank. Declare the app's protected customer data fields in the Dev Dashboard (Apps → API access → Protected customer data), then re-run.",
  },
  no_orders: {
    tone: "warn",
    text: "PCD check inconclusive — the store has no orders yet. Re-run after the first order to confirm PII isn't being redacted.",
  },
  not_connected: {
    tone: "warn",
    text: "PCD check: the store isn't connected yet. Have the merchant click Connect, then re-run.",
  },
  tenant_not_found: { tone: "err", text: "PCD check failed — tenant not found." },
  error: { tone: "err", text: "PCD check couldn't run (Shopify error). Try again." },
};
const TONE_CLASS: Record<Tone, string> = {
  ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  err: "border-red-500/30 bg-red-500/10 text-red-300",
};

interface PageProps {
  readonly params: Promise<{ readonly id: string }>;
  readonly searchParams?: Promise<
    Readonly<Record<string, string | string[] | undefined>>
  >;
}

const firstParam = (
  v: string | string[] | undefined,
): string | undefined => (Array.isArray(v) ? v[0] : v);

export default async function TenantDetailPage({
  params,
  searchParams,
}: PageProps) {
  await requireSession();
  const { id } = await params;
  const detail = await adminApi.tenantDetail(id);
  if (!detail) notFound();

  const sp = (await searchParams) ?? {};
  const okMsg = OK_MESSAGES[firstParam(sp["ok"]) ?? ""];
  const errMsg = ERROR_MESSAGES[firstParam(sp["error"]) ?? ""];
  const pcdMsg = PCD_MESSAGES[firstParam(sp["pcd"]) ?? ""];

  const { tenant, shopifyApp, connections } = detail;
  const provision = provisionShopifyAppAction.bind(null, id);
  const revoke = revokeShopifyAppAction.bind(null, id);
  const runPcd = runPcdCheckAction.bind(null, id);
  const setWorkspaceLlm = setWorkspaceOpenRouterAction.bind(null, id);
  const revokeWorkspaceLlm = revokeWorkspaceOpenRouterAction.bind(null, id);
  const remove = deleteTenantAction.bind(null, id);

  return (
    <>
      <Header crumb={tenant.name} />
      <main className="mx-auto max-w-3xl space-y-8 px-6 py-8">
        {okMsg ? (
          <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
            {okMsg}
          </p>
        ) : null}
        {errMsg ? (
          <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {errMsg}
          </p>
        ) : null}
        {pcdMsg ? (
          <p
            className={`rounded-md border px-3 py-2 text-sm ${TONE_CLASS[pcdMsg.tone]}`}
          >
            {pcdMsg.text}
          </p>
        ) : null}

        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {tenant.name}
          </h1>
          <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
            <dt className="text-zinc-500">Tenant ID</dt>
            <dd className="font-mono text-zinc-300">{tenant.id}</dd>
            <dt className="text-zinc-500">WorkOS org</dt>
            <dd className="font-mono text-zinc-300">
              {tenant.workosOrganizationId ?? "—"}
            </dd>
            <dt className="text-zinc-500">Shopify domain</dt>
            <dd className="font-mono text-zinc-300">
              {tenant.shopifyDomain ?? "—"}
            </dd>
            <dt className="text-zinc-500">Created</dt>
            <dd className="text-zinc-300">
              {new Date(tenant.createdAt).toLocaleString()}
            </dd>
          </dl>
        </div>

        {/* ---- Shopify custom app ---- */}
        <section className="space-y-4 rounded-lg border border-zinc-800 p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium">Shopify custom app</h2>
            <StatusBadge status={shopifyApp?.status ?? null} />
          </div>
          {shopifyApp ? (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
              <dt className="text-zinc-500">Client ID</dt>
              <dd className="font-mono text-zinc-300">{shopifyApp.clientId}</dd>
              <dt className="text-zinc-500">Connected shop</dt>
              <dd className="font-mono text-zinc-300">
                {shopifyApp.shopDomain ?? "— (not connected yet)"}
              </dd>
              <dt className="text-zinc-500">Updated</dt>
              <dd className="text-zinc-300">
                {new Date(shopifyApp.updatedAt).toLocaleString()}
              </dd>
            </dl>
          ) : (
            <p className="text-sm text-zinc-400">
              Not provisioned. Create a Shopify custom app for this store, then
              paste its API key + secret below to enable the merchant&apos;s
              Connect button.
            </p>
          )}

          <form action={provision} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor="clientId" className="text-sm text-zinc-300">
                  Client ID (API key)
                </label>
                <input
                  id="clientId"
                  name="clientId"
                  required
                  defaultValue={shopifyApp?.clientId ?? ""}
                  className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-sm outline-none focus:border-zinc-500"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="clientSecret" className="text-sm text-zinc-300">
                  Client secret
                </label>
                <input
                  id="clientSecret"
                  name="clientSecret"
                  type="password"
                  required
                  autoComplete="off"
                  placeholder={shopifyApp ? "•••••• (re-enter to rotate)" : ""}
                  className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-sm outline-none focus:border-zinc-500"
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <label htmlFor="shopDomain" className="text-sm text-zinc-300">
                  Store domain{" "}
                  <span className="text-zinc-500">
                    (required for pilot installs)
                  </span>
                </label>
                <input
                  id="shopDomain"
                  name="shopDomain"
                  inputMode="url"
                  autoComplete="off"
                  placeholder="acme.myshopify.com"
                  defaultValue={shopifyApp?.shopDomain ?? ""}
                  className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-sm outline-none focus:border-zinc-500"
                />
                <p className="text-xs text-zinc-500">
                  Custom-distribution store this app is for. Recorded up front so
                  the merchant&apos;s Connect goes straight to the store&apos;s
                  OAuth screen and direct install links resolve to this tenant.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <SubmitButton
                pendingLabel="Saving…"
                className="rounded-md bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 hover:bg-white"
              >
                {shopifyApp ? "Rotate credentials" : "Provision app"}
              </SubmitButton>
            </div>
          </form>

          {/* Custom-distribution setup checklist — the two Dev Dashboard
              steps that aren't captured by the credentials above. */}
          <div className="space-y-2 rounded-md border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-400">
            <p className="font-medium text-zinc-300">
              Dev Dashboard checklist (per app)
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                Set the app&apos;s distribution to{" "}
                <span className="text-zinc-200">Custom distribution</span> — not
                Public/unlisted. Custom distribution needs no Shopify review.
              </li>
              <li>
                Declare protected customer data fields (Apps → API access →
                Protected customer data): <span className="text-zinc-200">name,
                email, address</span> — not phone. Without this, live stores
                return orders with customer PII blanked.
              </li>
              <li>
                After the merchant connects, run the PCD check below to confirm
                customer PII isn&apos;t being redacted.
              </li>
            </ul>
          </div>

          {shopifyApp ? (
            <form
              action={runPcd}
              className="flex items-center gap-3 border-t border-zinc-800 pt-3"
            >
              <SubmitButton
                pendingLabel="Checking…"
                className="rounded-md border border-zinc-700 px-3 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-800"
              >
                Run PCD check
              </SubmitButton>
              <span className="text-xs text-zinc-500">
                Reads a few recent orders and reports whether customer PII comes
                back populated or redacted.
              </span>
            </form>
          ) : null}

          {shopifyApp && shopifyApp.status !== "revoked" ? (
            <form action={revoke} className="border-t border-zinc-800 pt-3">
              <SubmitButton
                pendingLabel="Revoking…"
                className="text-sm text-red-400 hover:text-red-300"
              >
                Revoke provisioning
              </SubmitButton>
            </form>
          ) : null}
        </section>

        {/* ---- Connector health ---- */}
        <section className="space-y-3">
          <h2 className="text-lg font-medium">Connectors</h2>
          {connections.length === 0 ? (
            <p className="rounded-md border border-zinc-800 px-4 py-6 text-center text-sm text-zinc-400">
              No connector connections.
            </p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-zinc-800">
              <table className="w-full text-sm">
                <thead className="bg-zinc-900/60 text-left text-xs uppercase tracking-wide text-zinc-400">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Provider</th>
                    <th className="px-4 py-2.5 font-medium">Account / shop</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                    <th className="px-4 py-2.5 font-medium">Scopes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {connections.map((c) => (
                    <tr key={c.id}>
                      <td className="px-4 py-2.5">{c.provider}</td>
                      <td className="px-4 py-2.5 font-mono text-xs text-zinc-400">
                        {c.shopDomain ?? "—"}
                      </td>
                      <td className="px-4 py-2.5">
                        <StatusBadge status={c.status} />
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs text-zinc-500">
                        {c.scopes.length ? c.scopes.join(", ") : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ---- OpenRouter ---- */}
        <section className="space-y-4 rounded-lg border border-zinc-800 p-5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-medium">OpenRouter</h2>
              <p className="mt-1 text-sm text-zinc-400">
                Effective source:{" "}
                <span className="text-zinc-200">
                  {detail.llm.effectiveSource ?? "none"}
                </span>
                {detail.llm.effectiveProvider
                  ? ` (${detail.llm.effectiveProvider})`
                  : ""}
              </p>
            </div>
            <StatusBadge
              status={detail.llm.effectiveSource ? "active" : null}
            />
          </div>
          {tenant.workosOrganizationId ? (
            <p className="text-sm text-zinc-400">
              Account default:{" "}
              <StatusBadge status={detail.llm.accountOpenrouter?.status ?? null} />{" "}
              <a
                href={`/accounts/${tenant.workosOrganizationId}`}
                className="text-zinc-300 hover:text-white hover:underline"
              >
                Manage account key
              </a>
            </p>
          ) : (
            <p className="text-sm text-zinc-500">
              This workspace has no WorkOS organization, so it cannot inherit an
              account key.
            </p>
          )}
          <form action={setWorkspaceLlm} className="space-y-3">
            <label htmlFor="workspaceApiKey" className="block text-sm text-zinc-300">
              Workspace OpenRouter override
            </label>
            <input
              id="workspaceApiKey"
              name="apiKey"
              type="password"
              required
              autoComplete="off"
              placeholder={
                detail.llm.workspaceOverride
                  ? "•••••• (re-enter to rotate)"
                  : "sk-or-v1-…"
              }
              className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-sm outline-none focus:border-zinc-500"
            />
            <SubmitButton
              pendingLabel="Saving…"
              className="rounded-md bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 hover:bg-white"
            >
              {detail.llm.workspaceOverride
                ? "Replace workspace override"
                : "Set workspace override"}
            </SubmitButton>
          </form>
          {detail.llm.workspaceOverride?.status === "active" ? (
            <form action={revokeWorkspaceLlm} className="border-t border-zinc-800 pt-3">
              <SubmitButton
                pendingLabel="Revoking…"
                className="text-sm text-red-400 hover:text-red-300"
              >
                Revoke workspace override
              </SubmitButton>
            </form>
          ) : null}
        </section>

        {/* ---- Danger zone ---- */}
        <section className="space-y-3 rounded-lg border border-red-500/30 p-5">
          <h2 className="text-lg font-medium text-red-300">Danger zone</h2>
          <p className="text-sm text-zinc-400">
            Permanently delete this tenant and all its data (cases, approvals,
            audit, connectors). This cannot be undone. Type{" "}
            <span className="font-mono text-zinc-200">{tenant.name}</span> to
            confirm.
          </p>
          <form action={remove} className="flex flex-wrap items-center gap-2">
            <input
              name="confirmName"
              required
              autoComplete="off"
              placeholder="Tenant name"
              className="grow rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-red-500/60"
            />
            <SubmitButton
              pendingLabel="Deleting…"
              className="rounded-md border border-red-500/40 px-3 py-2 text-sm font-medium text-red-300 hover:bg-red-500/10"
            >
              Delete tenant
            </SubmitButton>
          </form>
        </section>
      </main>
    </>
  );
}
