-- Backfill persisted duplicate-photo risk flags to the current vocabulary.
--
-- The perceptual-hash guard stamps one risk flag per prior ticket the same
-- customer photo appeared on. Before the case->ticket rename (code: 40084e6;
-- tables: migration 0036) that flag was `duplicate_photo_seen_in_case_<id>`; it
-- is now `duplicate_photo_seen_in_ticket_<id>`. The rename only changed what the
-- runtime STAMPS going forward — the old strings were left inside existing
-- tickets' `context.riskFlags` array, so the dashboard rendered a mix of
-- "Duplicate photo seen in case <uuid>" (the stale flag humanized, id leaked)
-- and "Duplicate photo seen on another ticket". This rewrites the leading marker
-- in place, preserving each flag's trailing ticket id and leaving every other
-- risk flag untouched.
--
-- The runtime dedupes flags via a Set before writing, but that keyed on the raw
-- string: a ticket that accrued both `..._in_case_<id>` and `..._in_ticket_<id>`
-- for the SAME prior ticket (across the rename) kept both, and rewriting the
-- former now yields two identical `..._in_ticket_<id>` entries. So the same pass
-- also de-duplicates the array, keeping each flag's first occurrence (and thus
-- the original order).
UPDATE "tickets" AS t
SET "context" = jsonb_set(
  t."context",
  '{riskFlags}',
  COALESCE(
    (
      SELECT jsonb_agg(flag ORDER BY ord)
      FROM (
        SELECT flag, MIN(ord) AS ord
        FROM (
          SELECT
            CASE
              WHEN elem LIKE 'duplicate_photo_seen_in_case_%'
                THEN regexp_replace(
                       elem,
                       '^duplicate_photo_seen_in_case_',
                       'duplicate_photo_seen_in_ticket_'
                     )
              ELSE elem
            END AS flag,
            ord
          FROM jsonb_array_elements_text(t."context"->'riskFlags')
            WITH ORDINALITY AS a(elem, ord)
        ) renamed
        GROUP BY flag
      ) deduped
    ),
    '[]'::jsonb
  )
)
WHERE jsonb_typeof(t."context"->'riskFlags') = 'array'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(t."context"->'riskFlags') AS f(elem)
    WHERE f.elem LIKE 'duplicate_photo_seen_in_case_%'
  );
