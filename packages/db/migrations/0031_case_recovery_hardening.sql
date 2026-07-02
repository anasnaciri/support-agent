-- Case recovery hardening (double-send + stale-approval-replay fixes).
--
-- `cases.epoch`      — per-case "round" counter, bumped on every resume/takeover.
-- `approvals.epoch`  — the round the approval was created in.
-- `approvals.resumed_at` — set once a decision has been ACTED ON (executed,
--                     deduped, or deliberately skipped). A handled approval is
--                     never re-run by a later bundle and never re-published by
--                     the maintenance sweep.
--
-- Together these fence a case's current round from leftovers of prior rounds:
-- an approval whose epoch != its case's epoch (or whose resumed_at is set) is
-- stale and must not execute or drive a status change.
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "epoch" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "epoch" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "resumed_at" timestamp with time zone;
