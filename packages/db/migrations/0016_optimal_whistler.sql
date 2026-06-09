CREATE TABLE "tenant_knowledge_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"source_type" text NOT NULL,
	"source_url" text,
	"content_hash" text,
	"fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_knowledge_documents_source_type_check" CHECK ("tenant_knowledge_documents"."source_type" IN ('text','url'))
);
--> statement-breakpoint
ALTER TABLE "tenant_knowledge_documents" ADD CONSTRAINT "tenant_knowledge_documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tenant_knowledge_documents_tenant_idx" ON "tenant_knowledge_documents" USING btree ("tenant_id");