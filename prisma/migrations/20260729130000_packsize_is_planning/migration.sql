-- Add the planning-membership business rule to PackSize.
ALTER TABLE "PackSize" ADD COLUMN "isPlanning" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "PackSize_isPlanning_idx" ON "PackSize"("isPlanning");

-- Backfill: mark the 7 canonical Dealer Planning pack sizes as planning columns and pin
-- their displayOrder to the workbook order (1..7). All other pack sizes (e.g. legacy /
-- price-import sizes like "1 KG", "2 KG", "5 KG", "500 ML", "10 ML") remain isPlanning=false
-- and are therefore excluded from Dealer Planning — kept in the master, not deleted.
UPDATE "PackSize" SET "isPlanning" = true, "displayOrder" = 1 WHERE "name" = '1,2 & 5 LTR/KG';
UPDATE "PackSize" SET "isPlanning" = true, "displayOrder" = 2 WHERE "name" = '500 ML/KG';
UPDATE "PackSize" SET "isPlanning" = true, "displayOrder" = 3 WHERE "name" = '250 ML';
UPDATE "PackSize" SET "isPlanning" = true, "displayOrder" = 4 WHERE "name" = '100 ML';
UPDATE "PackSize" SET "isPlanning" = true, "displayOrder" = 5 WHERE "name" = '50 ML';
UPDATE "PackSize" SET "isPlanning" = true, "displayOrder" = 6 WHERE "name" = '25 ML';
UPDATE "PackSize" SET "isPlanning" = true, "displayOrder" = 7 WHERE "name" = '10/15 ML';
