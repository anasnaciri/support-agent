import { Effect, ManagedRuntime } from "effect";
import { buildWorker } from "./bootstrap.js";
import {
  DEFAULT_WORKFLOW_QUEUE_NAME,
  ensureWorkflowQueue,
  reviveDomainEvent,
} from "./workflow-queue-live.js";
import {
  processWorkflowEvent,
  registerWorkflowConsumer,
  workflowConsumerConfig,
} from "./workflow-consumer.js";
import {
  WORKFLOW_DEAD_LETTER_QUEUE,
  registerWorkflowDeadLetterConsumer,
} from "./workflow-dead-letter.js";
import {
  GMAIL_WATCH_RENEWAL_QUEUE,
  registerGmailWatchRenewal,
} from "./gmail-watch-renewal-schedule.js";
import {
  GRAPH_SUBSCRIPTION_RENEWAL_QUEUE,
  registerGraphSubscriptionRenewal,
} from "./graph-subscription-renewal-schedule.js";
import { IMAP_POLL_QUEUE, registerImapPoll } from "./imap-poll-schedule.js";
import {
  RETENTION_SWEEP_QUEUE,
  registerRetentionSweep,
} from "./retention-sweep-schedule.js";
import {
  TIMER_SWEEP_QUEUE,
  registerTimerSweep,
} from "./timer-sweep-schedule.js";
import {
  SUPPLIER_NOTIFY_QUEUE,
  registerSupplierNotifySweep,
} from "./supplier-notify-schedule.js";
import {
  APPROVAL_MAINTENANCE_QUEUE,
  registerApprovalMaintenance,
} from "./approval-maintenance-schedule.js";
import {
  ACCOUNT_CLEANUP_QUEUE,
  registerAccountCleanup,
} from "./account-cleanup-schedule.js";
import {
  SHOPIFY_POLICY_IMPORT_QUEUE,
  registerShopifyPolicyImport,
} from "./shopify-policy-import-schedule.js";
import {
  LLM_CREDITS_QUEUE,
  registerLlmCreditsCheck,
} from "./llm-credits-schedule.js";
import {
  REPLY_DELIVERY_RETRY_QUEUE,
  registerReplyDeliveryRetrySweep,
} from "./reply-delivery-retry-schedule.js";

const main = async (): Promise<void> => {
  const { boss, runtimeLayer, credentialEncryptionKeys, shutdown } =
    await buildWorker();

  // Build the full layer graph ONCE for the job hot path (audit L12).
  // `Effect.provide(…, runtimeLayer)` inside the handler rebuilt every
  // service — including a fresh Postgres pool — per job; under burst
  // load that churned connections and turned pool exhaustion into
  // dropped events. Cron schedules still take the layer (they run every
  // few minutes; per-pass rebuild is immaterial there).
  const managedRuntime = ManagedRuntime.make(runtimeLayer);

  // pg-boss requires the queue exist before work() will register a worker.
  // We call ensureWorkflowQueue (idempotent) inside an Effect runtime so we
  // get the same error mapping path as the EventBus side.
  await Effect.runPromise(ensureWorkflowQueue(boss));

  // Concurrent pg-boss consumer. Deliberately a raw work() (bypasses
  // WorkflowQueuePgBossLive on the consumer side — the Layer-composed consumer
  // has a known flake where the poll loop never starts). `key_strict_fifo`
  // keeps same-case events strictly ordered while distinct cases/threads run in
  // parallel; the old SINGLE serial worker threw that away and let one slow
  // message.received run starve every approval behind it. See
  // ./workflow-consumer.ts.
  const consumerConfig = workflowConsumerConfig(process.env);
  const workerId = await registerWorkflowConsumer({
    boss,
    concurrency: consumerConfig.concurrency,
    onJob: async (job) => {
      const event = reviveDomainEvent(job.data.event);
      console.log(
        `[worker] ${event.type} eventId=${job.data.eventId} key=${job.data.key}`,
      );
      const settlement = await processWorkflowEvent({
        runtime: managedRuntime,
        event,
        tickTimeoutMs: consumerConfig.tickTimeoutMs,
      });
      if (settlement.kind === "complete") {
        const r = settlement.result;
        console.log(
          `[worker] ${event.type} -> ${r.type}` +
            (r.type === "Failed"
              ? ` (reason: ${r.reason})`
              : r.type === "HumanTakeoverRequired"
                ? ` (reason: ${r.reason})`
                : r.type === "PausedWaitingForApproval"
                  ? ` (approvalId: ${r.approvalId})`
                  : r.type === "PausedForHumanTakeover"
                    ? ` (held — case under human takeover)`
                    : ""),
        );
        return;
      }
      // Retryable failures (incl. a tick that blew its wall-clock budget) must
      // throw so pg-boss applies its retry policy; acking here would drop the
      // event forever (audit C1). Exhausted retries land on the dead-letter
      // queue, whose consumer parks the case for a human.
      if (settlement.kind === "retry") {
        throw new Error(`retryable workflow failure: ${settlement.reason}`);
      }
      // Defect — log + rethrow so pg-boss retries.
      console.error(`[worker] ${event.type} crashed:\n${settlement.detail}`);
      throw new Error(`AgentRuntime crashed: ${settlement.detail}`);
    },
  });

  console.log(
    `[worker] running. workerId=${workerId} queue=${DEFAULT_WORKFLOW_QUEUE_NAME} ` +
      `concurrency=${consumerConfig.concurrency} tickTimeoutMs=${consumerConfig.tickTimeoutMs}`,
  );

  // Dead-letter consumer: parks the case behind any workflow event that
  // exhausted its retries in human_takeover so the failure is visible on
  // the dashboard instead of silently dropped (audit C1/L11).
  const deadLetterWorkerId = await registerWorkflowDeadLetterConsumer({
    boss,
    runtimeLayer,
  });
  console.log(
    `[worker] dead-letter consumer running. workerId=${deadLetterWorkerId} queue=${WORKFLOW_DEAD_LETTER_QUEUE}`,
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

  // Schedule the Graph subscription-renewal cron. No-ops when Microsoft
  // OAuth + webhook env vars are missing.
  const graphRenewalRegistered = await registerGraphSubscriptionRenewal({
    boss,
    runtimeLayer,
  });
  if (graphRenewalRegistered) {
    console.log(
      `[worker] scheduled graph-subscription-renewal cron on queue=${GRAPH_SUBSCRIPTION_RENEWAL_QUEUE}`,
    );
  }

  // Schedule the IMAP inbound poll cron. No-ops when CREDENTIAL_ENCRYPTION_KEY
  // is missing (no generic-mailbox decryption possible).
  const imapPollRegistered = await registerImapPoll({ boss, runtimeLayer });
  if (imapPollRegistered) {
    console.log(`[worker] scheduled imap-poll cron on queue=${IMAP_POLL_QUEUE}`);
  }

  // Daily retention sweep: deletes resolved cases (and their audit /
  // approval rows) past each tenant's configured retention window.
  // Always registered — every tenant benefits regardless of which
  // connectors are wired up.
  await registerRetentionSweep({ boss, runtimeLayer });
  console.log(
    `[worker] scheduled retention-sweep cron on queue=${RETENTION_SWEEP_QUEUE}`,
  );

  await registerTimerSweep({ boss, runtimeLayer });
  console.log(
    `[worker] scheduled timer-sweep cron on queue=${TIMER_SWEEP_QUEUE}`,
  );

  // Supplier notification sweep: the durable outbox relay for supplier
  // escalation emails (notified_at ledger drives retry). The portal deep link
  // uses DASHBOARD_BASE_URL when set; otherwise the email omits the link.
  await registerSupplierNotifySweep({
    boss,
    runtimeLayer,
    portalBaseUrl: process.env["DASHBOARD_BASE_URL"] ?? null,
  });
  console.log(
    `[worker] scheduled supplier-notify cron on queue=${SUPPLIER_NOTIFY_QUEUE}`,
  );

  // Approvals maintenance: expires overdue pendings (escalating their
  // case to a human) and re-publishes decision events that were lost
  // between the decision commit and the pg-boss publish.
  await registerApprovalMaintenance({ boss, runtimeLayer });
  console.log(
    `[worker] scheduled approval-maintenance cron on queue=${APPROVAL_MAINTENANCE_QUEUE}`,
  );

  // Account-deletion cleanup: deletes the WorkOS org + sends the deletion
  // email for tenants wiped by apps/api's account-delete endpoints.
  await registerAccountCleanup({
    boss,
    runtimeLayer,
    encryptionKeys: credentialEncryptionKeys,
  });
  console.log(
    `[worker] consuming account-cleanup on queue=${ACCOUNT_CLEANUP_QUEUE}`,
  );

  // Post-connect shop-policy import: seeds the tenant knowledge base with the
  // store's shipping + refund policies. Best-effort (logs + swallows).
  await registerShopifyPolicyImport({ boss, runtimeLayer });
  console.log(
    `[worker] consuming shopify-policy-import on queue=${SHOPIFY_POLICY_IMPORT_QUEUE}`,
  );

  // OpenRouter credits-low check: pings the merchant once per
  // below-threshold crossing so prepaid keys don't silently hit zero.
  await registerLlmCreditsCheck({ boss, runtimeLayer });
  console.log(
    `[worker] scheduled llm-credits cron on queue=${LLM_CREDITS_QUEUE}`,
  );

  // Reply-delivery retry sweep: re-sends customer replies whose send failed
  // (the reply_deliveries outbox), auto-resolving the case on success and
  // abandoning to human_takeover at the attempt cap.
  await registerReplyDeliveryRetrySweep({ boss, runtimeLayer });
  console.log(
    `[worker] scheduled reply-delivery-retry cron on queue=${REPLY_DELIVERY_RETRY_QUEUE}`,
  );

  const onShutdown = async (signal: NodeJS.Signals) => {
    console.log(`[worker] received ${signal}, shutting down`);
    await managedRuntime.dispose();
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
