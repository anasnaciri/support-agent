CREATE TABLE "tenant_agent_overrides" (
	"tenant_id" uuid NOT NULL,
	"agent_id" text NOT NULL,
	"model" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_agent_overrides_tenant_id_agent_id_pk" PRIMARY KEY("tenant_id","agent_id")
);
--> statement-breakpoint
ALTER TABLE "tenant_agent_overrides" ADD CONSTRAINT "tenant_agent_overrides_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;