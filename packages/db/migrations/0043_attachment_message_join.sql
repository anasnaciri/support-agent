CREATE TABLE "ticket_attachment_messages" (
	"tenant_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"attachment_id" uuid NOT NULL,
	"message_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_attachment_messages_tenant_id_ticket_id_attachment_id_message_id_pk" PRIMARY KEY("tenant_id","ticket_id","attachment_id","message_id")
);
--> statement-breakpoint
INSERT INTO "ticket_attachment_messages" (
	"tenant_id",
	"ticket_id",
	"attachment_id",
	"message_id",
	"created_at"
)
SELECT
	"tenant_id",
	"ticket_id",
	"id",
	"message_id",
	"created_at"
FROM "ticket_attachments"
WHERE "message_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "ticket_attachment_messages" ADD CONSTRAINT "ticket_attachment_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_attachment_messages" ADD CONSTRAINT "ticket_attachment_messages_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_attachment_messages" ADD CONSTRAINT "ticket_attachment_messages_attachment_id_ticket_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."ticket_attachments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ticket_attachment_messages_message_idx" ON "ticket_attachment_messages" USING btree ("ticket_id","message_id");--> statement-breakpoint
CREATE INDEX "ticket_attachment_messages_attachment_idx" ON "ticket_attachment_messages" USING btree ("attachment_id");--> statement-breakpoint
DROP INDEX IF EXISTS "ticket_attachments_message_idx";--> statement-breakpoint
ALTER TABLE "ticket_attachments" DROP COLUMN "message_id";
