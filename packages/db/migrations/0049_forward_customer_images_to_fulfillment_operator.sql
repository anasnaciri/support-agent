CREATE TABLE "ticket_fulfillment_operator_escalation_attachments" (
	"tenant_id" uuid NOT NULL,
	"escalation_id" uuid NOT NULL,
	"attachment_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fulfillment_operator_escalation_attachments_pk" PRIMARY KEY("escalation_id","attachment_id")
);
--> statement-breakpoint
ALTER TABLE "ticket_fulfillment_operator_escalation_attachments" ADD CONSTRAINT "ticket_fulfillment_operator_escalation_attachments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ticket_fulfillment_operator_escalation_attachments" ADD CONSTRAINT "ticket_fulfillment_operator_escalation_attachments_escalation_id_ticket_fulfillment_operator_escalations_id_fk" FOREIGN KEY ("escalation_id") REFERENCES "public"."ticket_fulfillment_operator_escalations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ticket_fulfillment_operator_escalation_attachments" ADD CONSTRAINT "ticket_fulfillment_operator_escalation_attachments_attachment_id_ticket_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."ticket_attachments"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "fulfillment_operator_escalation_attachments_attachment_idx" ON "ticket_fulfillment_operator_escalation_attachments" USING btree ("attachment_id");
--> statement-breakpoint
CREATE INDEX "fulfillment_operator_escalation_attachments_tenant_idx" ON "ticket_fulfillment_operator_escalation_attachments" USING btree ("tenant_id");
