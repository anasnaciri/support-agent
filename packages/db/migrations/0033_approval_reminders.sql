ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "last_reminded_at" timestamp with time zone;
