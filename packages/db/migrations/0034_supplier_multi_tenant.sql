DROP INDEX IF EXISTS "suppliers_user_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_tenant_user_unique" ON "suppliers" USING btree ("tenant_id","user_decision_uuid") WHERE "user_decision_uuid" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "suppliers_user_idx" ON "suppliers" USING btree ("user_decision_uuid");
