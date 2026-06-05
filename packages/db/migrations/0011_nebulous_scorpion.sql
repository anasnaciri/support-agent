CREATE TABLE "shopify_app_provisioning" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_encrypted" "bytea" NOT NULL,
	"shop_domain" text,
	"status" text DEFAULT 'ready' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shopify_app_provisioning_status_check" CHECK ("shopify_app_provisioning"."status" IN ('ready','connected','revoked'))
);
--> statement-breakpoint
ALTER TABLE "shopify_app_provisioning" ADD CONSTRAINT "shopify_app_provisioning_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shopify_app_provisioning_tenant_unique" ON "shopify_app_provisioning" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "shopify_app_provisioning_shop_idx" ON "shopify_app_provisioning" USING btree ("shop_domain") WHERE "shopify_app_provisioning"."shop_domain" IS NOT NULL;