import "server-only";
import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import { makeEnqueuedWorkflowEvent } from "@support-agent/services";
import type { DomainEvent } from "@support-agent/agent-core";

// ============================================================
// pg-boss publisher (dashboard)
// ============================================================
//
// Mirror of apps/api's `makePgBossApprovalPublisher`. The dashboard's
// Server Actions enqueue `approval.approved` / `approval.rejected`
// events here so the worker resumes the case. Single cached connection
// per Node process (Next.js keeps the server long-lived).
//
// Deliberately not abstracted behind a Tag — the dashboard isn't built
// on Effect, and the worker / api each have their own publishers. If
// we end up with a third publisher, lift this into a workspace package.

const WORKFLOW_QUEUE = "workflow.events";

let cachedBoss: PgBoss | null = null;

const acquireBoss = async (): Promise<PgBoss> => {
  if (cachedBoss) return cachedBoss;
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to publish workflow events");
  }
  const boss = new PgBoss({
    connectionString: databaseUrl,
    schema: "pgboss",
  });
  boss.on("error", (err: Error) => {
    // eslint-disable-next-line no-console
    console.error("[dashboard pg-boss] error", err);
  });
  await boss.start();
  await boss.createQueue(WORKFLOW_QUEUE, {
    policy: "key_strict_fifo",
    retryLimit: 5,
    retryBackoff: true,
  });
  cachedBoss = boss;
  return boss;
};

export const publishWorkflowEvent = async (event: DomainEvent): Promise<void> => {
  const boss = await acquireBoss();
  const enqueued = makeEnqueuedWorkflowEvent(event, { eventId: randomUUID() });
  await boss.send(
    WORKFLOW_QUEUE,
    {
      eventId: enqueued.eventId,
      event: enqueued.event,
      key: enqueued.key,
      enqueuedAt: enqueued.enqueuedAt.toISOString(),
    },
    { singletonKey: enqueued.key },
  );
};
