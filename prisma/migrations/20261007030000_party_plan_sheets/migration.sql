-- Party Planning list/detail headers ("sheets"). Seasonal: one per (owner, Season). Monthly: one per (owner, SeasonMonth). The existing
-- row tables (SeasonalPlan, PartyMonthlyPlan) keep every column and value; they only gain a sheetId. Requires the Seasonal Planning
-- (20261007010000) and Monthly Planning (20261007020000) migrations first.

CREATE TABLE "SeasonalPlanSheet" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SeasonalPlanSheet_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SeasonalPlanSheet_ownerId_seasonId_key" ON "SeasonalPlanSheet"("ownerId", "seasonId");
CREATE INDEX "SeasonalPlanSheet_seasonId_idx" ON "SeasonalPlanSheet"("seasonId");
ALTER TABLE "SeasonalPlanSheet" ADD CONSTRAINT "SeasonalPlanSheet_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SeasonalPlanSheet" ADD CONSTRAINT "SeasonalPlanSheet_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "PartyMonthlySheet" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "seasonMonthId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PartyMonthlySheet_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PartyMonthlySheet_ownerId_seasonMonthId_key" ON "PartyMonthlySheet"("ownerId", "seasonMonthId");
CREATE INDEX "PartyMonthlySheet_seasonId_idx" ON "PartyMonthlySheet"("seasonId");
ALTER TABLE "PartyMonthlySheet" ADD CONSTRAINT "PartyMonthlySheet_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PartyMonthlySheet" ADD CONSTRAINT "PartyMonthlySheet_seasonMonthId_fkey" FOREIGN KEY ("seasonMonthId") REFERENCES "SeasonMonth"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PartyMonthlySheet" ADD CONSTRAINT "PartyMonthlySheet_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Link the existing rows: add the column nullable, give every existing (owner, season) / (owner, month) its sheet, then make it required.
ALTER TABLE "SeasonalPlan" ADD COLUMN "sheetId" TEXT;
INSERT INTO "SeasonalPlanSheet" ("id", "seasonId", "ownerId", "createdAt", "updatedAt")
  SELECT 'sps_' || md5("ownerId" || ':' || "seasonId"), "seasonId", "ownerId", MIN("createdAt"), MAX("updatedAt") FROM "SeasonalPlan" GROUP BY "ownerId", "seasonId";
UPDATE "SeasonalPlan" SET "sheetId" = 'sps_' || md5("ownerId" || ':' || "seasonId");
ALTER TABLE "SeasonalPlan" ALTER COLUMN "sheetId" SET NOT NULL;
CREATE INDEX "SeasonalPlan_sheetId_idx" ON "SeasonalPlan"("sheetId");
ALTER TABLE "SeasonalPlan" ADD CONSTRAINT "SeasonalPlan_sheetId_fkey" FOREIGN KEY ("sheetId") REFERENCES "SeasonalPlanSheet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PartyMonthlyPlan" ADD COLUMN "sheetId" TEXT;
INSERT INTO "PartyMonthlySheet" ("id", "seasonId", "seasonMonthId", "ownerId", "createdAt", "updatedAt")
  SELECT 'pms_' || md5("ownerId" || ':' || "seasonMonthId"), MIN("seasonId"), "seasonMonthId", "ownerId", MIN("createdAt"), MAX("updatedAt") FROM "PartyMonthlyPlan" GROUP BY "ownerId", "seasonMonthId";
UPDATE "PartyMonthlyPlan" SET "sheetId" = 'pms_' || md5("ownerId" || ':' || "seasonMonthId");
ALTER TABLE "PartyMonthlyPlan" ALTER COLUMN "sheetId" SET NOT NULL;
CREATE INDEX "PartyMonthlyPlan_sheetId_idx" ON "PartyMonthlyPlan"("sheetId");
ALTER TABLE "PartyMonthlyPlan" ADD CONSTRAINT "PartyMonthlyPlan_sheetId_fkey" FOREIGN KEY ("sheetId") REFERENCES "PartyMonthlySheet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
