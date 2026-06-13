CREATE TABLE "account_openrouter_credentials" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"api_key_encrypted" bytea NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_openrouter_credentials_status_check" CHECK ("account_openrouter_credentials"."status" IN ('active','revoked'))
);
--> statement-breakpoint
CREATE INDEX "account_openrouter_credentials_active_idx" ON "account_openrouter_credentials" USING btree ("organization_id") WHERE "account_openrouter_credentials"."status" = 'active';
