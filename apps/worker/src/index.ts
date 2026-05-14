import { makeQueue } from "./queue.js";

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const boss = await makeQueue({ databaseUrl });

await boss.createQueue("worker.heartbeat");
await boss.work<{ at: string }>("worker.heartbeat", async (jobs) => {
  for (const job of jobs) {
    console.log("[worker] heartbeat", job.id, job.data);
  }
});

console.log("[worker] running. Send a job with:");
console.log(
  '  pnpm --filter @support-agent/worker exec node -e "..."',
);

const shutdown = async () => {
  console.log("[worker] shutting down");
  await boss.stop({ graceful: true });
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
