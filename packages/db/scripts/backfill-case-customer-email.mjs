// One-off prod maintenance: inspect / backfill a case's `context.customerEmail`.
//
// WHY: cases created before the Reply-To fix (fix/honor-reply-to-header) that
// arrived via a relay (Shopify storefront contact form: From mailer@shopify.com,
// Reply-To the shopper) stamped `customerEmail = mailer@shopify.com`. A reply
// would go to the relay, not the customer. This sets it to the real address.
//
// Runs ON the deployed host (it has DATABASE_URL). Resolves `postgres` from
// packages/db, so run it from there:
//
//   # dry-run — print the case row + current customerEmail, mutate nothing:
//   cd packages/db && node scripts/backfill-case-customer-email.mjs <caseId>
//
//   # apply — set context.customerEmail (merges, keeps every other context key):
//   cd packages/db && node scripts/backfill-case-customer-email.mjs <caseId> --email=jane@shopper.com
//
import process from "node:process";
import postgres from "postgres";

const caseId = process.argv[2];
const emailArg =
  (process.argv.find((a) => a.startsWith("--email=")) ?? "").split("=")[1] ??
  null;

if (!caseId) {
  console.error(
    "usage: node scripts/backfill-case-customer-email.mjs <caseId> [--email=<addr>]",
  );
  process.exit(1);
}
if (emailArg !== null && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailArg)) {
  console.error(`refusing to write a non-email value: ${JSON.stringify(emailArg)}`);
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });

try {
  const rows = await sql`
    select id, tenant_id, thread_id, mailbox, provider, status, subject,
           summary, context
    from cases
    where id = ${caseId}
  `;
  if (rows.length === 0) {
    console.error(`case not found: ${caseId}`);
    process.exit(2);
  }
  const c = rows[0];
  console.log("case:", {
    id: c.id,
    tenantId: c.tenant_id,
    threadId: c.thread_id,
    mailbox: c.mailbox,
    provider: c.provider,
    status: c.status,
    subject: c.subject,
  });
  console.log("summary:", c.summary ?? null);
  console.log("current context.customerEmail:", c.context?.customerEmail ?? null);
  console.log("full context:", JSON.stringify(c.context, null, 2));

  if (emailArg === null) {
    console.log(
      "\nDRY RUN — nothing written. Re-run with --email=<addr> to set context.customerEmail.",
    );
    process.exit(0);
  }

  const nextContext = { ...(c.context ?? {}), customerEmail: emailArg };
  await sql`
    update cases
    set context = ${sql.json(nextContext)}, updated_at = now()
    where id = ${caseId}
  `;
  const [after] = await sql`select context from cases where id = ${caseId}`;
  console.log(
    `\nUPDATED context.customerEmail: ${c.context?.customerEmail ?? null} -> ${after.context?.customerEmail ?? null}`,
  );
} finally {
  await sql.end({ timeout: 5 });
}
