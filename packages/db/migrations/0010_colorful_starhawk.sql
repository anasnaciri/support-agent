CREATE TABLE "image_hashes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"phash" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "image_hashes" ADD CONSTRAINT "image_hashes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_hashes" ADD CONSTRAINT "image_hashes_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "image_hashes_tenant_created_idx" ON "image_hashes" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "image_hashes_case_idx" ON "image_hashes" USING btree ("case_id");
