ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "cases" DROP CONSTRAINT IF EXISTS "cases_status_check";
--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_status_check" CHECK ("status" IN ('new','triaging','in_progress','waiting_for_customer','waiting_for_supplier','waiting_for_approval','approved_action_running','resolved','archived','failed','human_takeover'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cases_tenant_status_resolved_at_idx" ON "cases" USING btree ("tenant_id","status","resolved_at") WHERE "resolved_at" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cases_tenant_status_archived_at_idx" ON "cases" USING btree ("tenant_id","status","archived_at") WHERE "archived_at" IS NOT NULL;
