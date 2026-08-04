-- Plan Lifecycle Management (Seasonal / Monthly / Recovery).
-- Adds an ACTIVE/CLOSED/DEACTIVATED lifecycle axis that is INDEPENDENT of the approval `status`,
-- and links Recovery plans to their parent Seasonal plan. Everything defaults to ACTIVE so all
-- existing rows and queries behave exactly as before until the new filters opt in.

-- --- SeasonPlan -----------------------------------------------------------
ALTER TABLE "SeasonPlan" ADD COLUMN "lifecycleState" TEXT NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "SeasonPlan" ADD COLUMN "closedAt" TIMESTAMP(3);
ALTER TABLE "SeasonPlan" ADD COLUMN "deactivatedAt" TIMESTAMP(3);
CREATE INDEX "SeasonPlan_lifecycleState_idx" ON "SeasonPlan"("lifecycleState");

-- --- MonthlyPlan ----------------------------------------------------------
ALTER TABLE "MonthlyPlan" ADD COLUMN "lifecycleState" TEXT NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "MonthlyPlan" ADD COLUMN "closedAt" TIMESTAMP(3);
ALTER TABLE "MonthlyPlan" ADD COLUMN "deactivatedAt" TIMESTAMP(3);
CREATE INDEX "MonthlyPlan_lifecycleState_idx" ON "MonthlyPlan"("lifecycleState");

-- --- RecoveryPlan ---------------------------------------------------------
ALTER TABLE "RecoveryPlan" ADD COLUMN "lifecycleState" TEXT NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "RecoveryPlan" ADD COLUMN "closedAt" TIMESTAMP(3);
ALTER TABLE "RecoveryPlan" ADD COLUMN "deactivatedAt" TIMESTAMP(3);
ALTER TABLE "RecoveryPlan" ADD COLUMN "seasonPlanId" TEXT;
CREATE INDEX "RecoveryPlan_lifecycleState_idx" ON "RecoveryPlan"("lifecycleState");
CREATE INDEX "RecoveryPlan_seasonPlanId_idx" ON "RecoveryPlan"("seasonPlanId");
ALTER TABLE "RecoveryPlan"
  ADD CONSTRAINT "RecoveryPlan_seasonPlanId_fkey"
  FOREIGN KEY ("seasonPlanId") REFERENCES "SeasonPlan"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: link each existing Recovery plan to the officer's SEASONAL plan for the same season.
-- Prefer the active version; otherwise the highest version. Recovery plans with no matching
-- seasonal plan stay NULL (still valid — keyed by season + officer).
UPDATE "RecoveryPlan" AS rp
SET "seasonPlanId" = sp."id"
FROM "SeasonPlan" AS sp
WHERE sp."seasonId" = rp."seasonId"
  AND sp."officerId" = rp."officerId"
  AND sp."planningType" = 'SEASONAL'
  AND sp."id" = (
    SELECT s2."id"
    FROM "SeasonPlan" AS s2
    WHERE s2."seasonId" = rp."seasonId"
      AND s2."officerId" = rp."officerId"
      AND s2."planningType" = 'SEASONAL'
    ORDER BY s2."isActiveVersion" DESC, s2."version" DESC
    LIMIT 1
  );
