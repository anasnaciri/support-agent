-- Bind supplier-uploaded attachments to the escalation they were uploaded
-- against. Two things need this:
--   1. Validation scope: `recordSupplierUpdate` only accepted "a supplier-source
--      row on this ticket", so a second escalation could re-send the first
--      one's files by id. The column narrows it to this escalation.
--   2. The supplier portal's resolved-escalation view renders the files the
--      supplier actually sent for THAT escalation.
-- Null for merchant uploads and inbound (customer) attachments. Existing
-- supplier rows stay null: they predate the binding and are only reachable
-- through the ticket context stamp the update already wrote.
ALTER TABLE "ticket_attachments" ADD COLUMN "escalation_id" uuid;--> statement-breakpoint
ALTER TABLE "ticket_attachments" ADD CONSTRAINT "ticket_attachments_escalation_id_ticket_supplier_escalations_id_fk" FOREIGN KEY ("escalation_id") REFERENCES "public"."ticket_supplier_escalations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ticket_attachments_escalation_idx" ON "ticket_attachments" USING btree ("escalation_id");
