-- Make tickets.context.scenarioKey the single persisted source of scenario
-- identity. Legacy tickets predate the scenario-driven agent and stored their
-- classification in tickets.category; preserve that value only when no
-- canonical scenario has subsequently been selected.
UPDATE "tickets"
SET "context" = jsonb_set(
  "context",
  '{scenarioKey}',
  to_jsonb("category"),
  true
)
WHERE "category" IS NOT NULL
  AND NOT ("context" ? 'scenarioKey');
