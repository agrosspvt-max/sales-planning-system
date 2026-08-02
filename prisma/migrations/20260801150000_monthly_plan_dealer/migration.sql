-- Per-dealer "No Plan" state within a Monthly Plan (the monthly analogue of PlanDealer.noPlan).
-- Completed / Remaining stay derived from the stored monthly plan values; only No Plan is stored.

CREATE TABLE "MonthlyPlanDealer" (
    "id" TEXT NOT NULL,
    "monthlyPlanId" TEXT NOT NULL,
    "dealerId" TEXT NOT NULL,
    "noPlan" BOOLEAN NOT NULL DEFAULT false,
    "noPlanReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MonthlyPlanDealer_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MonthlyPlanDealer_monthlyPlanId_dealerId_key" ON "MonthlyPlanDealer"("monthlyPlanId", "dealerId");
CREATE INDEX "MonthlyPlanDealer_monthlyPlanId_idx" ON "MonthlyPlanDealer"("monthlyPlanId");
ALTER TABLE "MonthlyPlanDealer" ADD CONSTRAINT "MonthlyPlanDealer_monthlyPlanId_fkey" FOREIGN KEY ("monthlyPlanId") REFERENCES "MonthlyPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
