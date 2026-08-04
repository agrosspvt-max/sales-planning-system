-- Plan lifecycle integrity fixes.
-- 1) Track whether a child's non-ACTIVE state came from a parent cascade (so reopening a parent
--    does not un-close a month an admin closed on purpose).
-- 2) Recovery must always belong to a Seasonal plan: change the FK from SET NULL to RESTRICT and
--    backfill any remaining unlinked recovery plans.

ALTER TABLE "MonthlyPlan"  ADD COLUMN "lifecycleFromParent" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "RecoveryPlan" ADD COLUMN "lifecycleFromParent" BOOLEAN NOT NULL DEFAULT false;

-- Backfill any recovery plan still missing its seasonal parent (best effort: the officer's SEASONAL
-- plan for the same season, active version preferred).
UPDATE "RecoveryPlan" AS rp
SET "seasonPlanId" = (
    SELECT s2."id"
    FROM "SeasonPlan" AS s2
    WHERE s2."seasonId" = rp."seasonId"
      AND s2."officerId" = rp."officerId"
      AND s2."planningType" = 'SEASONAL'
    ORDER BY s2."isActiveVersion" DESC, s2."version" DESC
    LIMIT 1
)
WHERE rp."seasonPlanId" IS NULL;

-- Swap SET NULL → RESTRICT so a seasonal plan cannot be deleted out from under its recovery plans.
ALTER TABLE "RecoveryPlan" DROP CONSTRAINT "RecoveryPlan_seasonPlanId_fkey";
ALTER TABLE "RecoveryPlan"
  ADD CONSTRAINT "RecoveryPlan_seasonPlanId_fkey"
  FOREIGN KEY ("seasonPlanId") REFERENCES "SeasonPlan"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
