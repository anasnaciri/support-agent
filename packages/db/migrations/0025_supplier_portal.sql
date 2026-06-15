CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"user_decision_uuid" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_supplier_escalations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"problem" text NOT NULL,
	"order_ref" text,
	"ship_city" text,
	"ship_country" text,
	"tracking_number" text,
	"status" text DEFAULT 'open' NOT NULL,
	"note" text,
	"proposed_resolution" text,
	"notified_at" timestamp with time zone,
	"notify_attempts" integer DEFAULT 0 NOT NULL,
	"last_notify_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "case_supplier_escalations_status_check" CHECK ("case_supplier_escalations"."status" IN ('open','resolved'))
);
--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_supplier_escalations" ADD CONSTRAINT "case_supplier_escalations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_supplier_escalations" ADD CONSTRAINT "case_supplier_escalations_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_supplier_escalations" ADD CONSTRAINT "case_supplier_escalations_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_tenant_email_unique" ON "suppliers" USING btree ("tenant_id",lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_user_unique" ON "suppliers" USING btree ("user_decision_uuid") WHERE "suppliers"."user_decision_uuid" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "suppliers_tenant_idx" ON "suppliers" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "cse_supplier_status_idx" ON "case_supplier_escalations" USING btree ("supplier_id","status");--> statement-breakpoint
CREATE INDEX "cse_case_idx" ON "case_supplier_escalations" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "cse_tenant_idx" ON "case_supplier_escalations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "cse_unsent_idx" ON "case_supplier_escalations" USING btree ("created_at") WHERE "case_supplier_escalations"."notified_at" IS NULL;