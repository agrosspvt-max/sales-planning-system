-- Daily Work: add the Dealer Appointment + Scheme Conversion sections. Additive + a uniqueness-key change.
-- No historical row is deleted; existing SALES/RECOVERY rows are backfilled so their identity is unchanged.

-- 1) New daily-only columns (all nullable; rowKey defaulted so existing rows are valid immediately).
ALTER TABLE "DailyWorkEntry" ADD COLUMN "rowKey"          TEXT NOT NULL DEFAULT '';
ALTER TABLE "DailyWorkEntry" ADD COLUMN "typedDealerName" TEXT;
ALTER TABLE "DailyWorkEntry" ADD COLUMN "marketName"      TEXT;
ALTER TABLE "DailyWorkEntry" ADD COLUMN "resultStatus"    TEXT;

-- 2) Backfill rowKey for existing SALES/RECOVERY rows = their dealerId (identity preserved).
UPDATE "DailyWorkEntry" SET "rowKey" = "dealerId" WHERE "rowKey" = '' AND "dealerId" IS NOT NULL;

-- 3) dealerId becomes nullable (typed APPOINTMENT rows have no Dealer master row).
ALTER TABLE "DailyWorkEntry" ALTER COLUMN "dealerId" DROP NOT NULL;

-- 4) Swap the uniqueness from (officer, date, section, dealerId) to (officer, date, section, rowKey),
--    so Scheme Conversion allows one row per (dealer, scheme) and Appointment allows multiple typed rows.
DROP INDEX IF EXISTS "DailyWorkEntry_officerId_workDate_section_dealerId_key";
CREATE UNIQUE INDEX "DailyWorkEntry_officerId_workDate_section_rowKey_key"
  ON "DailyWorkEntry" ("officerId", "workDate", "section", "rowKey");
