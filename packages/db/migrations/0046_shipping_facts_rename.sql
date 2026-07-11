-- Rename the `shippingProfile` block of `tenants.settings` to `shippingFacts`.
--
-- The block shipped as "shipping profile" and was renamed to "shipping facts"
-- (2026-07-11) so it reads as the sibling of `returnsFacts` — Facts are the
-- merchant's stated grounding values an agent may quote, as opposed to the
-- *Policy structures the runtime enforces. This moves the persisted key so the
-- code has exactly one name for it and no read-time fallback.
--
-- Value-preserving: the block is moved verbatim, not re-decoded. Rows without
-- the key are untouched.
UPDATE "tenants"
SET "settings" = ("settings" - 'shippingProfile')
  || jsonb_build_object('shippingFacts', "settings" -> 'shippingProfile')
WHERE "settings" -> 'shippingProfile' IS NOT NULL
  AND "settings" -> 'shippingFacts' IS NULL;--> statement-breakpoint
-- A row carrying BOTH keys can only come from a save through the renamed code
-- before this migration ran, so the new key is the authoritative one and the
-- old one is stale — drop it rather than overwrite with it.
UPDATE "tenants"
SET "settings" = "settings" - 'shippingProfile'
WHERE "settings" -> 'shippingProfile' IS NOT NULL;
