DROP INDEX "cases_tenant_thread_unique";--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "mailbox" text;--> statement-breakpoint
CREATE UNIQUE INDEX "cases_tenant_provider_mailbox_thread_unique" ON "cases" USING btree ("tenant_id","provider","mailbox","thread_id") WHERE "cases"."thread_id" IS NOT NULL AND "cases"."provider" IS NOT NULL AND "cases"."mailbox" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "cases_tenant_legacy_thread_unique" ON "cases" USING btree ("tenant_id","thread_id") WHERE "cases"."thread_id" IS NOT NULL AND "cases"."mailbox" IS NULL;