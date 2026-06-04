import { Context, Effect, Layer } from "effect";
import {
  OrgDirectoryDeleteFailed,
  OrgDirectoryService,
} from "@support-agent/services";

// ============================================================
// WorkosConfig Tag
// ============================================================
//
// Kept distinct from `OrgDirectoryService` so the abstract Tag doesn't
// leak WorkOS-specific shape. A second IdP gets its own Config Tag + Live
// Layer, both providing into `OrgDirectoryService`. Mirrors `ResendConfig`.

export class WorkosConfig extends Context.Tag("WorkosConfig")<
  WorkosConfig,
  {
    /** WorkOS secret API key (`sk_...`). */
    readonly apiKey: string;
    /** Override for tests; production uses global `fetch`. */
    readonly fetchImpl?: typeof fetch;
  }
>() {}

// ============================================================
// WorkOS Live layer for OrgDirectoryService
// ============================================================
//
// We call the WorkOS REST API directly over `fetch` (DELETE
// /organizations/:id) rather than pulling in the `@workos-inc/node` SDK —
// the operation is a single request, and fetch keeps the layer trivially
// testable (inject `fetchImpl`), exactly like the Resend mail layer.

const WORKOS_API_BASE = "https://api.workos.com";

export const OrgDirectoryServiceLive = Layer.effect(
  OrgDirectoryService,
  Effect.gen(function* () {
    const config = yield* WorkosConfig;
    const fetchImpl = config.fetchImpl ?? fetch;

    return OrgDirectoryService.of({
      deleteOrganization: (organizationId) =>
        Effect.gen(function* () {
          const res = yield* Effect.tryPromise({
            try: () =>
              fetchImpl(
                `${WORKOS_API_BASE}/organizations/${encodeURIComponent(
                  organizationId,
                )}`,
                {
                  method: "DELETE",
                  headers: { Authorization: `Bearer ${config.apiKey}` },
                },
              ),
            catch: (cause) =>
              new OrgDirectoryDeleteFailed({ organizationId, cause }),
          });

          // 404 → the org is already gone. Treat as success so a pg-boss
          // retry (e.g. after the email step failed) drains cleanly
          // instead of looping forever on an org that no longer exists.
          if (res.ok || res.status === 404) return;

          const body = yield* Effect.promise(() =>
            res.text().catch(() => ""),
          );
          return yield* Effect.fail(
            new OrgDirectoryDeleteFailed({
              organizationId,
              cause: { status: res.status, body },
            }),
          );
        }),
    });
  }),
);

// ============================================================
// Env-driven config helper
// ============================================================
//
// Reads WORKOS_API_KEY. Fails Layer build if missing so we don't silently
// no-op org deletion on a misconfigured production worker.

export const WorkosConfigFromEnv = Layer.effect(
  WorkosConfig,
  Effect.sync(() => {
    const apiKey = process.env["WORKOS_API_KEY"];
    if (!apiKey) throw new Error("WORKOS_API_KEY is required");
    return { apiKey };
  }),
);
