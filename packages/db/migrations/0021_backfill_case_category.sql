-- Backfill `cases.category` from the triage classification recorded in the
-- context blob. Until now `case.update_context` only wrote `classification`
-- into `context`, so every runtime-created case has a NULL category column
-- (the dashboard showed them all as "uncategorized"). The tool now mirrors
-- classification into the column; this brings existing rows in line.
UPDATE "cases"
SET "category" = "context"->>'classification'
WHERE "category" IS NULL
  AND "context"->>'classification' IS NOT NULL;
