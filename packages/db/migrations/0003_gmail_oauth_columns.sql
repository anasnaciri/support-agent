ALTER TABLE "connector_connections" ADD COLUMN "refresh_token_encrypted" "bytea";--> statement-breakpoint
ALTER TABLE "connector_connections" ADD COLUMN "token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connector_connections" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;