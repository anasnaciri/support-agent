CREATE TABLE "processed_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"message_id" text NOT NULL,
	"thread_id" text,
	"case_id" uuid,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"call_id" text NOT NULL,
	"tool" text NOT NULL,
	"executed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"result_ok" boolean
);
--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "processed_messages" ADD CONSTRAINT "processed_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processed_messages" ADD CONSTRAINT "processed_messages_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_executions" ADD CONSTRAINT "tool_executions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_executions" ADD CONSTRAINT "tool_executions_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "processed_messages_tenant_provider_message_unique" ON "processed_messages" USING btree ("tenant_id","provider","message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_executions_case_call_unique" ON "tool_executions" USING btree ("case_id","call_id");--> statement-breakpoint
CREATE INDEX "approvals_case_idx" ON "approvals" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "audit_log_tenant_id_idx" ON "audit_log" USING btree ("tenant_id","id" DESC);--> statement-breakpoint
CREATE INDEX "audit_log_tenant_action_occurred_idx" ON "audit_log" USING btree ("tenant_id","action","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cases_tenant_thread_unique" ON "cases" USING btree ("tenant_id","thread_id") WHERE "cases"."thread_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "connector_connections_active_mailbox_unique" ON "connector_connections" USING btree ("provider","shop_domain") WHERE "connector_connections"."provider" IN ('gmail','outlook','imap') AND "connector_connections"."status" = 'active';--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_provider_check" CHECK ("cases"."provider" IN ('gmail','outlook','imap'));