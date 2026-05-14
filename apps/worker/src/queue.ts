import { PgBoss } from "pg-boss";

export interface QueueOptions {
  readonly databaseUrl: string;
  readonly schema?: string;
}

export const makeQueue = async (opts: QueueOptions): Promise<PgBoss> => {
  const boss = new PgBoss({
    connectionString: opts.databaseUrl,
    schema: opts.schema ?? "pgboss",
  });
  boss.on("error", (err: Error) => {
    console.error("[pg-boss] error", err);
  });
  await boss.start();
  return boss;
};

export { PgBoss };
