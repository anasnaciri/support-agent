-- De-duplicate `tickets.context.riskFlags` across the board.
--
-- 0037 only de-duplicated rows that still carried a legacy
-- `duplicate_photo_seen_in_case_<id>` flag (its rewrite could create a twin of
-- an existing `..._in_ticket_<id>`). But some arrays hold exact duplicates with
-- no legacy flag to trip that filter — e.g. a row written before the code paths
-- gained their `includes()` de-dupe guard. Those slipped through and the
-- dashboard still counted the same ticket twice ("seen in N tickets", one repeated).
--
-- This pass collapses ANY exact-duplicate entry in the array, keeping each
-- flag's first occurrence (and thus the original order). It only touches rows
-- that actually contain a duplicate (array length > distinct count).
UPDATE "tickets" AS t
SET "context" = jsonb_set(
  t."context",
  '{riskFlags}',
  COALESCE(
    (
      SELECT jsonb_agg(elem ORDER BY ord)
      FROM (
        SELECT elem, MIN(ord) AS ord
        FROM jsonb_array_elements_text(t."context"->'riskFlags')
          WITH ORDINALITY AS a(elem, ord)
        GROUP BY elem
      ) deduped
    ),
    '[]'::jsonb
  )
)
WHERE jsonb_typeof(t."context"->'riskFlags') = 'array'
  AND jsonb_array_length(t."context"->'riskFlags') > (
    SELECT count(DISTINCT elem)
    FROM jsonb_array_elements_text(t."context"->'riskFlags') AS g(elem)
  );
