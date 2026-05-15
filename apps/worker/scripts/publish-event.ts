/**
 * Publish a synthetic `ticket.created` event onto the workflow queue so a
 * locally-running worker can process it end-to-end. Useful for manual
 * smoke testing without the (not yet built) Gmail inbound webhook.
 *
 * Usage (from repo root):
 *   set -a; source .env.local; set +a
 *   pnpm --filter @support-agent/worker exec tsx scripts/publish-event.ts \
 *     --tenant <tenantId> \
 *     --subject "where is my order?" \
 *     --body "Hi, my order #1001 was shipped a week ago and I haven't received it."
 *
 * Defaults: a fresh UUID tenant, subject "test", body "test body".
 *
 * The worker (started separately via `pnpm --filter @support-agent/worker
 * start` or `tsx src/index.ts`) will consume the event, drive support-triage
 * through the runtime, and you'll see it land at "resolved".
 */

import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { TenantId, type DomainEvent } from "@support-agent/agent-core";
import { makeDbClient, tenants } from "@support-agent/db";
import { makeQueue } from "../src/queue.js";
import { enqueueWorkflowEvent } from "../src/workflow-queue-live.js";

const parseArgs = (
  argv: ReadonlyArray<string>,
): {
  tenant: string;
  subject: string;
  body: string;
  customerEmail: string | null;
} => {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key && key.startsWith("--")) {
      const value = argv[i + 1] ?? "";
      args.set(key.slice(2), value);
      i++;
    }
  }
  return {
    tenant: args.get("tenant") ?? randomUUID(),
    subject: args.get("subject") ?? "test",
    body: args.get("body") ?? "test body",
    customerEmail: args.get("customer-email") ?? null,
  };
};

const main = async () => {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const opts = parseArgs(process.argv.slice(2));
  console.log(`[publish] tenant=${opts.tenant}`);
  console.log(`[publish] subject=${opts.subject}`);
  console.log(`[publish] body=${opts.body}`);

  // Tenant must exist (cases.tenant_id FK). Upsert idempotently so re-runs
  // with the same tenant id reuse the same row.
  const raw = makeDbClient({ databaseUrl });
  try {
    await raw.db
      .insert(tenants)
      .values({ id: opts.tenant, name: `smoke-${opts.tenant.slice(0, 8)}` })
      .onConflictDoNothing();
  } finally {
    await raw.close();
  }

  const boss = await makeQueue({ databaseUrl });
  try {
    const event: DomainEvent = {
      type: "ticket.created",
      tenantId: TenantId(opts.tenant),
      source: "api",
      payload: {
        subject: opts.subject,
        body: opts.body,
        customerEmail: opts.customerEmail,
        metadata: {},
      },
    };
    const enqueued = await Effect.runPromise(enqueueWorkflowEvent(boss, event));
    console.log(`[publish] ok jobId=${enqueued.jobId} eventId=${enqueued.eventId}`);
    console.log(`[publish] key=${enqueued.key}`);
  } finally {
    await boss.stop({ graceful: true });
  }
};

main().catch((err: unknown) => {
  console.error("[publish] fatal:", err);
  process.exit(1);
});
