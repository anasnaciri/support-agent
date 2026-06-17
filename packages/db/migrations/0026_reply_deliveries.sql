CREATE TABLE "reply_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"agent_id" text NOT NULL,
	"tool" text NOT NULL,
	"mailbox" text,
	"draft_id" text NOT NULL,
	"draft" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 6 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "reply_deliveries_status_check" CHECK ("reply_deliveries"."status" IN ('pending','sent','abandoned'))
);
--> statement-breakpoint
ALTER TABLE "reply_deliveries" ADD CONSTRAINT "reply_deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_deliveries" ADD CONSTRAINT "reply_deliveries_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reply_deliveries_due_idx" ON "reply_deliveries" USING btree ("next_attempt_at") WHERE "reply_deliveries"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "reply_deliveries_case_idx" ON "reply_deliveries" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "reply_deliveries_tenant_idx" ON "reply_deliveries" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reply_deliveries_case_draft_pending_unique" ON "reply_deliveries" USING btree ("case_id","draft_id") WHERE "reply_deliveries"."status" = 'pending';