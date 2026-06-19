CREATE TABLE "case_message_ids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"message_id" text NOT NULL,
	"direction" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "case_message_ids_direction_check" CHECK ("case_message_ids"."direction" IN ('inbound','outbound'))
);
--> statement-breakpoint
ALTER TABLE "case_message_ids" ADD CONSTRAINT "case_message_ids_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_message_ids" ADD CONSTRAINT "case_message_ids_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "case_message_ids_tenant_message_unique" ON "case_message_ids" USING btree ("tenant_id","message_id");--> statement-breakpoint
CREATE INDEX "case_message_ids_case_idx" ON "case_message_ids" USING btree ("case_id");