-- Expand Scheme Master without losing the original scheme value.
ALTER TABLE "Scheme" RENAME COLUMN "schemeValue" TO "schemeValueWithoutGST";
ALTER TABLE "Scheme" ADD COLUMN "schemeValueWithGST" DECIMAL(14,2) NOT NULL DEFAULT 0;
-- Existing historical records had one value only, so retain that amount in both fields.
UPDATE "Scheme" SET "schemeValueWithGST" = "schemeValueWithoutGST";
ALTER TABLE "Scheme" ALTER COLUMN "schemeValueWithGST" DROP DEFAULT;

ALTER TABLE "Scheme" ADD COLUMN "isPerpetual" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Scheme" ADD COLUMN "benefitDetails" TEXT;
ALTER TABLE "Scheme" ALTER COLUMN "startDate" DROP NOT NULL;
ALTER TABLE "Scheme" ALTER COLUMN "endDate" DROP NOT NULL;
ALTER TABLE "Scheme" ALTER COLUMN "bookingLastDate" DROP NOT NULL;

DROP INDEX IF EXISTS "Scheme_startDate_endDate_idx";
CREATE INDEX "Scheme_isPerpetual_endDate_idx" ON "Scheme"("isPerpetual", "endDate");
