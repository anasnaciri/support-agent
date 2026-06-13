import { randomBytes, randomUUID } from "node:crypto";
import { Effect, Layer } from "effect";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccountOpenRouterCredentialStore } from "@support-agent/services";
import {
  AccountOpenRouterCredentialStoreLive,
  DbClientLive,
  accountOpenrouterCredentials,
  makeDbClient,
} from "../src/index.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("AccountOpenRouterCredentialStore (Live, integration)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const organizationId = `org_${randomUUID()}`;
  const encryptionKey = randomBytes(32);
  const layer = AccountOpenRouterCredentialStoreLive(encryptionKey).pipe(
    Layer.provide(DbClientLive({ databaseUrl: databaseUrl! })),
  );

  const run = <A, E>(
    effect: Effect.Effect<A, E, AccountOpenRouterCredentialStore>,
  ) => Effect.runPromise(Effect.provide(effect, layer).pipe(Effect.scoped));

  beforeAll(async () => {
    if (!raw) return;
    await raw.db
      .delete(accountOpenrouterCredentials)
      .where(eq(accountOpenrouterCredentials.organizationId, organizationId));
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.db
      .delete(accountOpenrouterCredentials)
      .where(eq(accountOpenrouterCredentials.organizationId, organizationId));
    await raw.close();
  });

  it("encrypts, rotates, revokes, and reactivates one key per account", async () => {
    const first = await run(
      Effect.gen(function* () {
        const store = yield* AccountOpenRouterCredentialStore;
        yield* store.put({
          organizationId,
          apiKey: "sk-or-v1-account-first",
        });
        return yield* store.get(organizationId);
      }),
    );
    expect(first?.apiKey).toBe("sk-or-v1-account-first");
    expect(first?.status).toBe("active");

    const [stored] = await raw!.db
      .select()
      .from(accountOpenrouterCredentials)
      .where(eq(accountOpenrouterCredentials.organizationId, organizationId));
    expect(stored?.apiKeyEncrypted.includes(Buffer.from(first!.apiKey))).toBe(
      false,
    );

    const rotated = await run(
      Effect.gen(function* () {
        const store = yield* AccountOpenRouterCredentialStore;
        yield* store.put({
          organizationId,
          apiKey: "sk-or-v1-account-rotated",
        });
        return yield* store.get(organizationId);
      }),
    );
    expect(rotated?.apiKey).toBe("sk-or-v1-account-rotated");

    const revoked = await run(
      Effect.gen(function* () {
        const store = yield* AccountOpenRouterCredentialStore;
        expect(yield* store.revoke(organizationId)).toBe(true);
        return yield* store.get(organizationId);
      }),
    );
    expect(revoked?.status).toBe("revoked");

    const reactivated = await run(
      Effect.gen(function* () {
        const store = yield* AccountOpenRouterCredentialStore;
        yield* store.put({
          organizationId,
          apiKey: "sk-or-v1-account-reactivated",
        });
        return yield* store.get(organizationId);
      }),
    );
    expect(reactivated?.status).toBe("active");
    expect(reactivated?.apiKey).toBe("sk-or-v1-account-reactivated");
  });
});
