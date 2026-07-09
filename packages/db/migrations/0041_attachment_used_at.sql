-- Mark when an uploaded attachment was actually consumed into something
-- durable: attached to an outgoing customer reply, or bound into a supplier's
-- posted update. A row that is still NULL well past the upload is an orphan —
-- a chip the merchant staged and removed, or a draft nobody ever sent — and
-- the attachment GC sweep reclaims its blob.
--
-- Backfill: existing rows are stamped `used_at = created_at` rather than left
-- NULL. We cannot tell after the fact which of them were sent, and the sweep
-- must never delete a blob that a real reply or supplier update references.
-- Retaining a handful of genuinely-orphaned pre-existing uploads is the safe
-- direction to be wrong in.
ALTER TABLE "ticket_attachments" ADD COLUMN "used_at" timestamp with time zone;--> statement-breakpoint
UPDATE "ticket_attachments" SET "used_at" = "created_at";--> statement-breakpoint
-- The sweep scans for unused uploads by age; index only the rows it can match.
CREATE INDEX "ticket_attachments_unused_idx" ON "ticket_attachments" USING btree ("created_at") WHERE "used_at" IS NULL;
