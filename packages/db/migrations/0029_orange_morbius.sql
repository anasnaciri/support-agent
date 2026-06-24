CREATE TABLE "tenant_custom_agents" (
	"tenant_id" uuid NOT NULL,
	"agent_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"instructions" text NOT NULL,
	"model" text NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"handoffs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"callable_from" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"permission_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"when_to_use" text,
	"max_turns_per_tick" integer DEFAULT 6 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_custom_agents_tenant_id_agent_id_pk" PRIMARY KEY("tenant_id","agent_id"),
	CONSTRAINT "tenant_custom_agents_status_check" CHECK ("tenant_custom_agents"."status" IN ('draft','active','disabled'))
);
--> statement-breakpoint
ALTER TABLE "tenant_custom_agents" ADD CONSTRAINT "tenant_custom_agents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tenant_custom_agents_tenant_idx" ON "tenant_custom_agents" USING btree ("tenant_id");