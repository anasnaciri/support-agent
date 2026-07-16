CREATE TABLE "shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source" text NOT NULL,
	"source_order_id" text NOT NULL,
	"source_fulfillment_id" text NOT NULL,
	"tracking_number" text NOT NULL,
	"carrier" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"shipped_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"first_exception_at" timestamp with time zone,
	"last_event_at" timestamp with time zone,
	"last_scan_at" timestamp with time zone,
	"transit_days" integer,
	"destination_country" text,
	"tracking_stopped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipments_source_check" CHECK ("shipments"."source" IN ('shopify')),
	CONSTRAINT "shipments_status_check" CHECK ("shipments"."status" IN ('pending','in_transit','delivered','exception','unknown','stopped'))
);
--> statement-breakpoint
CREATE TABLE "shipment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"fingerprint" text NOT NULL,
	"status" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipment_events_provider_check" CHECK ("shipment_events"."provider" IN ('seventeentrack')),
	CONSTRAINT "shipment_events_status_check" CHECK ("shipment_events"."status" IN ('pending','in_transit','delivered','exception','unknown','stopped'))
);
--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_tenant_source_fulfillment_tracking_unique" ON "shipments" USING btree ("tenant_id","source","source_fulfillment_id","tracking_number");
--> statement-breakpoint
CREATE INDEX "shipments_tenant_status_idx" ON "shipments" USING btree ("tenant_id","status");
--> statement-breakpoint
CREATE INDEX "shipments_tenant_shipped_idx" ON "shipments" USING btree ("tenant_id","shipped_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_events_shipment_fingerprint_unique" ON "shipment_events" USING btree ("shipment_id","fingerprint");
--> statement-breakpoint
CREATE INDEX "shipment_events_shipment_occurred_idx" ON "shipment_events" USING btree ("shipment_id","occurred_at");
