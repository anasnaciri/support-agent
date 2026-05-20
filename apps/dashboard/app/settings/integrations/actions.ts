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
} from "@support-agent/services";
import { TenantId } from "@support-agent/agent-core";
import { getTenantId } from "@/lib/tenant";

const connectorStoreLayer = () => {
  const databaseUrl = process.env["DATABASE_URL"];
  const credKeyB64 = process.env["CREDENTIAL_ENCRYPTION_KEY"];
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (!credKeyB64) throw new Error("CREDENTIAL_ENCRYPTION_KEY is required");

  const db = DbClientLive({ databaseUrl });
  return ConnectorCredentialStoreLive(parseKey(credKeyB64)).pipe(
    Layer.provide(db),
  );
};

export const disconnectGmailAction = async (): Promise<void> => {
  const tenantId = await getTenantId();
  const tid = TenantId(tenantId);

  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const store = yield* ConnectorCredentialStore;
        const rows = yield* store.listForTenant(tid);
        const activeGmailRows = rows.filter(
          (row) => row.provider === "gmail" && row.status === "active",
        );
        yield* Effect.all(
          activeGmailRows.map((row) =>
            store.revoke(tid, "gmail", row.shopDomain),
          ),
          { concurrency: 1 },
        );
      }),
      connectorStoreLayer(),
    ).pipe(Effect.scoped),
  );

  revalidatePath("/settings/integrations");
  redirect("/settings/integrations?gmail=disconnected");
};
