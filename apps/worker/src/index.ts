import { Cause, Effect, Exit } from "effect";
import type { DomainEvent } from "@support-agent/agent-core";
import { AgentRuntime } from "@support-agent/services";
import { buildWorker } from "./bootstrap.js";
import {
  DEFAULT_WORKFLOW_QUEUE_NAME,
  ensureWorkflowQueue,
  reviveDomainEvent,
} from "./workflow-queue-live.js";
import {
  GMAIL_WATCH_RENEWAL_QUEUE,
  registerGmailWatchRenewal,
} from "./gmail-watch-renewal-schedule.js";

interface WorkflowJobData {
  readonly eventId: string;
  readonly event: DomainEvent;
  readonly key: string;
  readonly enqueuedAt: string;
}

const main = async (): Promise<void> => {
  const { boss, runtimeLayer, shutdown } = await buildWorker();

  // pg-boss requires the queue exist before work() will register a worker.
  // We call ensureWorkflowQueue (idempotent) inside an Effect runtime so we
  // get the same error mapping path as the EventBus side.
  await Effect.runPromise(ensureWorkflowQueue(boss));

  // Raw pg-boss work() — deliberately bypasses WorkflowQueuePgBossLive on
  // the consumer side. The Layer-composed consumer has a known flake where
  // the run() poll loop never starts (see event-bus-workflow-queue
  // integration test). We sidestep it by feeding each message into a
  // freshly-provided AgentRuntime here.
  const workerId = await boss.work<WorkflowJobData, void>(
    DEFAULT_WORKFLOW_QUEUE_NAME,
    async (jobs) => {
      for (const job of jobs) {
        const event = reviveDomainEvent(job.data.event);
        console.log(
          `[worker] ${event.type} eventId=${job.data.eventId} key=${job.data.key}`,
        );
        const exit = await Effect.runPromiseExit(
          Effect.provide(
            Effect.flatMap(AgentRuntime, (r) => r.handleEvent(event)),
            runtimeLayer,
          ),
        );
        if (Exit.isSuccess(exit)) {
          console.log(
            `[worker] ${event.type} -> ${exit.value.type}` +
              (exit.value.type === "Failed"
                ? ` (reason: ${exit.value.reason})`
                : exit.value.type === "HumanTakeoverRequired"
                  ? ` (reason: ${exit.value.reason})`
                  : exit.value.type === "PausedWaitingForApproval"
                    ? ` (approvalId: ${exit.value.approvalId})`
                    : ""),
          );
        } else {
          // E=never on handleEvent, so this can only be defects. Log + rethrow
          // so pg-boss applies its retry policy.
          console.error(
            `[worker] ${event.type} crashed:\n${Cause.pretty(exit.cause)}`,
          );
          throw new Error(`AgentRuntime crashed: ${Cause.pretty(exit.cause)}`);
        }
      }
    },
  );

  console.log(
    `[worker] running. workerId=${workerId} queue=${DEFAULT_WORKFLOW_QUEUE_NAME}`,
  );

  // Schedule the Gmail watch-renewal cron. No-ops when Google OAuth env
  // vars are missing — single-tenant dev runs that only exercise Shopify
  // don't need this.
  const renewalRegistered = await registerGmailWatchRenewal({
    boss,
    runtimeLayer,
  });
  if (renewalRegistered) {
    console.log(
      `[worker] scheduled gmail-watch-renewal cron on queue=${GMAIL_WATCH_RENEWAL_QUEUE}`,
    );
  }

  const onShutdown = async (signal: NodeJS.Signals) => {
    console.log(`[worker] received ${signal}, shutting down`);
    await shutdown();
    process.exit(0);
  };
  process.on("SIGINT", onShutdown);
  process.on("SIGTERM", onShutdown);
};

main().catch((err: unknown) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
