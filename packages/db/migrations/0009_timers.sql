CREATE TABLE "timers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"case_id" uuid NOT NULL,
	"fire_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"fired_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "timers_reason_check" CHECK ("timers"."reason" IN ('follow_up','sla','escalation'))
);
--> statement-breakpoint
ALTER TABLE "timers" ADD CONSTRAINT "timers_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "timers_due_idx" ON "timers" USING btree ("fire_at") WHERE "timers"."fired_at" IS NULL AND "timers"."cancelled_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "timers_case_idx" ON "timers" USING btree ("case_id","fire_at");
