CREATE TABLE "connector_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"shop_domain" text DEFAULT '' NOT NULL,
	"access_token_encrypted" "bytea" NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"api_version" text,
	"status" text DEFAULT 'active' NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_connections_status_check" CHECK ("connector_connections"."status" IN ('active','revoked')),
	CONSTRAINT "connector_connections_provider_check" CHECK ("connector_connections"."provider" IN ('shopify','gmail','outlook'))
);
--> statement-breakpoint
ALTER TABLE "connector_connections" ADD CONSTRAINT "connector_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connector_connections_tenant_provider_shop_idx" ON "connector_connections" USING btree ("tenant_id","provider","shop_domain");--> statement-breakpoint
CREATE INDEX "connector_connections_active_idx" ON "connector_connections" USING btree ("tenant_id","provider") WHERE "connector_connections"."status" = 'active';