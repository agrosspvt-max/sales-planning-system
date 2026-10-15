-- Daily Work → Dealer Appointment is linked to the owner's approved Monthly Party Planning entry.
-- Additive and nullable: existing (typed / calendar-generated) appointment rows keep working untouched and are never matched to a plan by name.
ALTER TABLE "DailyWorkEntry" ADD COLUMN "monthlyPlanId" TEXT;
ALTER TABLE "DailyWorkEntry" ADD COLUMN "marketId" TEXT;
ALTER TABLE "DailyWorkEntry" ADD COLUMN "resultEventId" TEXT;

CREATE INDEX "DailyWorkEntry_monthlyPlanId_idx" ON "DailyWorkEntry"("monthlyPlanId");

ALTER TABLE "DailyWorkEntry" ADD CONSTRAINT "DailyWorkEntry_monthlyPlanId_fkey"
  FOREIGN KEY ("monthlyPlanId") REFERENCES "PartyMonthlyPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
