CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"agent_id" text NOT NULL,
	"tool" text NOT NULL,
	"proposed_input" jsonb NOT NULL,
	"approved_input" jsonb,
	"reasoning" text,
	"risk_level" text NOT NULL,
	"status" text NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approvals_risk_level_check" CHECK ("approvals"."risk_level" IN ('low','medium','high','critical')),
	CONSTRAINT "approvals_status_check" CHECK ("approvals"."status" IN ('pending','approved','rejected','expired','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"details" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_actor_type_check" CHECK ("audit_log"."actor_type" IN ('agent','user','system','customer'))
);
--> statement-breakpoint
CREATE TABLE "case_state_transitions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"case_id" uuid NOT NULL,
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	"event_id" uuid,
	"reason" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid,
	"shopify_order_id" text,
	"channel" text NOT NULL,
	"thread_id" text,
	"category" text,
	"status" text NOT NULL,
	"current_agent_id" text NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"summary" text,
	"subject" text,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "cases_channel_check" CHECK ("cases"."channel" IN ('email','form','chat','api')),
	CONSTRAINT "cases_priority_check" CHECK ("cases"."priority" IN ('low','normal','high','urgent')),
	CONSTRAINT "cases_status_check" CHECK ("cases"."status" IN ('new','triaging','in_progress','waiting_for_customer','waiting_for_supplier','waiting_for_approval','approved_action_running','resolved','failed','human_takeover'))
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"shopify_domain" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_state_transitions" ADD CONSTRAINT "case_state_transitions_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_pending_idx" ON "approvals" USING btree ("tenant_id","status","expires_at") WHERE "approvals"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "audit_log_case_idx" ON "audit_log" USING btree ("case_id","id");--> statement-breakpoint
CREATE INDEX "cst_case_idx" ON "case_state_transitions" USING btree ("case_id","id");--> statement-breakpoint
CREATE INDEX "cases_tenant_status_idx" ON "cases" USING btree ("tenant_id","status","updated_at" DESC);--> statement-breakpoint
CREATE INDEX "cases_customer_idx" ON "cases" USING btree ("customer_id");