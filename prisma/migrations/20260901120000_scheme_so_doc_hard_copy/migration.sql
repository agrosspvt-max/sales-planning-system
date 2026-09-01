-- SO Document Status: add the new "Hard copy sent" state between "Soft copy sent" (SIGNED_AND_SENT)
-- and "HO received hard copy" (DOC_RECEIVED). Purely additive & non-destructive: every existing row
-- keeps its current value. The Admin doc enum (SchemeAdminDocStatus) and all summary/filter/eligibility
-- logic (which read the Admin field) are untouched.
--
-- User-facing labels (display only, not stored):
--   SIGNED_BUT_NOT_SENT -> "Signed but not sent"
--   SIGNED_AND_SENT     -> "Soft copy sent"
--   HARD_COPY_SENT      -> "Hard copy sent"   (new)
--   DOC_RECEIVED        -> "HO received hard copy"
--
-- Swap-type pattern (house convention) so the new value lands in the intended ordinal position.
-- No value remap needed — the three existing values map to themselves (identity).

-- 1) New enum type with the added value in position.
CREATE TYPE "SchemeSoDocStatus_new" AS ENUM ('SIGNED_BUT_NOT_SENT', 'SIGNED_AND_SENT', 'HARD_COPY_SENT', 'DOC_RECEIVED');

-- 2) Detach the column to text (existing values are already valid members of the new type).
ALTER TABLE "DealerSchemePlan" ALTER COLUMN "soDocumentStatus" TYPE TEXT USING "soDocumentStatus"::text;

-- 3) Adopt the new enum type and drop the old one.
ALTER TABLE "DealerSchemePlan"
  ALTER COLUMN "soDocumentStatus" TYPE "SchemeSoDocStatus_new" USING "soDocumentStatus"::"SchemeSoDocStatus_new";
DROP TYPE "SchemeSoDocStatus";
ALTER TYPE "SchemeSoDocStatus_new" RENAME TO "SchemeSoDocStatus";
