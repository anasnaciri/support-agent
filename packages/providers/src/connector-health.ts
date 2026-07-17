import { Effect } from "effect";
import {
  type ConnectorConnection,
  type ConnectorCredentialStore,
} from "@support-agent/services";

export type ConnectorHealthState = "ok" | "broken";

const currentHealth = (
  metadata: Readonly<Record<string, unknown>>,
): ConnectorHealthState =>
  metadata["connectorHealth"] === "broken" ? "broken" : "ok";

/**
 * Record provider-auth evidence without allowing health bookkeeping to change
 * the connector operation's result. Repeated observations of the same state
 * are no-ops; a later successful authenticated call heals a broken row.
 */
export const reportConnectorHealth = (
  store: ConnectorCredentialStore["Type"],
  connection: ConnectorConnection,
  next: ConnectorHealthState,
  reason: "auth_failed" | null,
): Effect.Effect<void, never> => {
  if (currentHealth(connection.metadata) === next) return Effect.void;

  return store
    .patchMetadata({
      tenantId: connection.tenantId,
      provider: connection.provider,
      shopDomain: connection.shopDomain,
      metadata: {
        connectorHealth: next,
        connectorHealthReason: reason,
        connectorHealthAt: new Date().toISOString(),
      },
    })
    .pipe(
      Effect.asVoid,
      Effect.catchAll((cause) =>
        Effect.logWarning(
          `[connector-health] failed to record ${next} for ${connection.provider}/${connection.shopDomain}: ${String(cause)}`,
        ),
      ),
    );
};

