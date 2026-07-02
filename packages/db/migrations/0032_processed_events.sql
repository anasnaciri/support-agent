-- Event-level redelivery dedup (H7). One row per pg-boss event_id; the
-- workflow consumer claims the id after a non-retryable settlement so a
-- re-delivered job (same id) is skipped on its next arrival.
CREATE TABLE IF NOT EXISTS "processed_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"event_type" text,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
