-- Phase 2 Part L/M: SO Document Status enum changes to the new SO-facing workflow values.
-- Explicit, documented mapping of existing rows (no NULLs, no data loss). Admin doc enum is untouched.
--   RECEIVED     -> DOC_RECEIVED
--   IN_TRANSIT   -> SIGNED_AND_SENT
--   NOT_RECEIVED -> SIGNED_BUT_NOT_SENT
-- Postgres enum values can't be renamed in place while data exists, so we create the new type, cast the
-- column to text, remap values, then cast to the new enum and drop the old type.

-- 1) New enum type.
CREATE TYPE "SchemeSoDocStatus_new" AS ENUM ('SIGNED_BUT_NOT_SENT', 'SIGNED_AND_SENT', 'DOC_RECEIVED');

-- 2) Detach the column from the old enum (to text) so we can remap the values.
ALTER TABLE "DealerSchemePlan" ALTER COLUMN "soDocumentStatus" TYPE TEXT USING "soDocumentStatus"::text;

-- 3) Remap existing values explicitly.
UPDATE "DealerSchemePlan" SET "soDocumentStatus" = 'DOC_RECEIVED'       WHERE "soDocumentStatus" = 'RECEIVED';
UPDATE "DealerSchemePlan" SET "soDocumentStatus" = 'SIGNED_AND_SENT'    WHERE "soDocumentStatus" = 'IN_TRANSIT';
UPDATE "DealerSchemePlan" SET "soDocumentStatus" = 'SIGNED_BUT_NOT_SENT' WHERE "soDocumentStatus" = 'NOT_RECEIVED';

-- 4) Adopt the new enum type and drop the old one.
ALTER TABLE "DealerSchemePlan"
  ALTER COLUMN "soDocumentStatus" TYPE "SchemeSoDocStatus_new" USING "soDocumentStatus"::"SchemeSoDocStatus_new";
DROP TYPE "SchemeSoDocStatus";
ALTER TYPE "SchemeSoDocStatus_new" RENAME TO "SchemeSoDocStatus";
