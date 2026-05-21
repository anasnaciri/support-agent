"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Effect, Layer } from "effect";
import {
  ConnectorCredentialStoreLive,
  DbClientLive,
} from "@support-agent/db";
import {
  ConnectorCredentialStore,
  parseKey,
  type LLMProvider,
} from "@support-agent/services";
import { TenantId } from "@support-agent/agent-core";
import { getTenantId } from "@/lib/tenant";

const LLM_PROVIDERS: ReadonlyArray<LLMProvider> = [
  "openrouter",
  "anthropic",
  "openai",
];

const isLlmProvider = (p: string): p is LLMProvider =>
  (LLM_PROVIDERS as ReadonlyArray<string>).includes(p);

const connectorStoreLayer = () => {
  const databaseUrl = process.env["DATABASE_URL"];
  const credKeyB64 = process.env["CREDENTIAL_ENCRYPTION_KEY"];
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (!credKeyB64)
    throw new Error(
      "CREDENTIAL_ENCRYPTION_KEY is required to persist LLM keys",
    );

  const db = DbClientLive({ databaseUrl });
  return ConnectorCredentialStoreLive(parseKey(credKeyB64)).pipe(
    Layer.provide(db),
  );
};

export const connectLlmAction = async (formData: FormData): Promise<void> => {
  const tenantId = await getTenantId();
  const tid = TenantId(tenantId);

  const providerRaw = formData.get("provider");
  const apiKeyRaw = formData.get("apiKey");
  const baseURLRaw = formData.get("baseURL");

  const provider = typeof providerRaw === "string" ? providerRaw.trim() : "";
  const apiKey = typeof apiKeyRaw === "string" ? apiKeyRaw.trim() : "";
  const baseURL = typeof baseURLRaw === "string" ? baseURLRaw.trim() : "";

  if (!isLlmProvider(provider)) {
    redirect("/settings/llm?error=bad_provider");
  }
  if (apiKey.length < 8) {
    redirect("/settings/llm?error=missing_key");
  }

  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const store = yield* ConnectorCredentialStore;
        // BYOK: at most one ACTIVE LLM provider per tenant — enforced by
        // the partial unique index added in migration 0006. Revoke any
        // existing active LLM rows first (whether same provider or
        // different) so the upsert below doesn't collide with the index.
        const rows = yield* store.listForTenant(tid);
        const activeLlmRows = rows.filter(
          (r) => isLlmProvider(r.provider) && r.status === "active",
        );
        yield* Effect.all(
          activeLlmRows.map((r) =>
            store.revoke(tid, r.provider as LLMProvider, r.shopDomain),
          ),
          { concurrency: 1 },
        );
        yield* store.put({
          tenantId: tid,
          provider,
          shopDomain: "default",
          accessToken: apiKey,
          scopes: [],
          ...(baseURL.length > 0
            ? { metadata: { baseURL } as Readonly<Record<string, unknown>> }
            : {}),
        });
      }),
      connectorStoreLayer(),
    ).pipe(Effect.scoped),
  );

  revalidatePath("/settings/llm");
  revalidatePath("/settings/integrations");
  redirect("/settings/llm?connected=1");
};

export const revokeLlmAction = async (): Promise<void> => {
  const tenantId = await getTenantId();
  const tid = TenantId(tenantId);

  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const store = yield* ConnectorCredentialStore;
        const rows = yield* store.listForTenant(tid);
        const activeLlmRows = rows.filter(
          (r) => isLlmProvider(r.provider) && r.status === "active",
        );
        yield* Effect.all(
          activeLlmRows.map((r) =>
            store.revoke(tid, r.provider as LLMProvider, r.shopDomain),
          ),
          { concurrency: 1 },
        );
      }),
      connectorStoreLayer(),
    ).pipe(Effect.scoped),
  );

  revalidatePath("/settings/llm");
  revalidatePath("/settings/integrations");
  redirect("/settings/llm?revoked=1");
};
