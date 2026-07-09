-- Bind an attachment to the conversation message it arrived on, so the ticket
-- thread can render a customer's photo under the message that carried it.
-- Set for `source='inbound'` rows (indexed by the runtime when the message
-- binds to a ticket); merchant/supplier uploads carry null — they belong to a
-- reply that has not been sent yet, not to a received message.
ALTER TABLE "ticket_attachments" ADD COLUMN "message_id" text;--> statement-breakpoint
CREATE INDEX "ticket_attachments_message_idx" ON "ticket_attachments" USING btree ("ticket_id","message_id");--> statement-breakpoint
-- Idempotent inbound indexing: a redelivered `message.received` re-runs the
-- same tx with the same storage keys (the blob was already uploaded by the
-- webhook), and must not add a second row. Storage keys are already unique per
-- upload/message, so this is the natural identity.
CREATE UNIQUE INDEX "ticket_attachments_tenant_key_uniq" ON "ticket_attachments" USING btree ("tenant_id","storage_key");
