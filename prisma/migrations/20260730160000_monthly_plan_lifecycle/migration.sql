-- Monthly Planning as a first-class lifecycle entity + Month Extension Requests.
-- MonthlyPlan reuses MonthlyEntry for data (no duplicate line/dealer store) and the
-- existing PlanStatus + ApprovalAction workflow for its lifecycle.

-- New notification types for the month-extension workflow.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'MONTH_EXTENSION_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'MONTH_EXTENSION_APPROVED';

-- ApprovalAction can now log a Monthly Plan's lifecycle (seasonPlanId = parent plan).
ALTER TABLE "ApprovalAction" ADD COLUMN "monthlyPlanId" TEXT;

-- MonthlyPlan — one lifecycle row per (approved seasonal plan, month).
CREATE TABLE "MonthlyPlan" (
    "id" TEXT NOT NULL,
    "seasonPlanId" TEXT NOT NULL,
    "seasonMonthId" TEXT NOT NULL,
    "officerId" TEXT NOT NULL,
    "status" "PlanStatus" NOT NULL DEFAULT 'DRAFT',
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "lastSavedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MonthlyPlan_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MonthlyPlan_seasonPlanId_seasonMonthId_key" ON "MonthlyPlan"("seasonPlanId", "seasonMonthId");
CREATE INDEX "MonthlyPlan_seasonPlanId_idx" ON "MonthlyPlan"("seasonPlanId");
CREATE INDEX "MonthlyPlan_officerId_idx" ON "MonthlyPlan"("officerId");
CREATE INDEX "MonthlyPlan_status_idx" ON "MonthlyPlan"("status");

-- MonthExtensionRequest — SO asks to append a future month; admin approves to apply.
CREATE TABLE "MonthExtensionRequest" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "monthName" TEXT NOT NULL,
    "monthOrder" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decisionNote" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MonthExtensionRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MonthExtensionRequest_seasonId_idx" ON "MonthExtensionRequest"("seasonId");
CREATE INDEX "MonthExtensionRequest_status_idx" ON "MonthExtensionRequest"("status");
CREATE INDEX "MonthExtensionRequest_createdAt_idx" ON "MonthExtensionRequest"("createdAt");

CREATE INDEX "ApprovalAction_monthlyPlanId_idx" ON "ApprovalAction"("monthlyPlanId");

-- Foreign keys.
ALTER TABLE "ApprovalAction" ADD CONSTRAINT "ApprovalAction_monthlyPlanId_fkey" FOREIGN KEY ("monthlyPlanId") REFERENCES "MonthlyPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MonthlyPlan" ADD CONSTRAINT "MonthlyPlan_seasonPlanId_fkey" FOREIGN KEY ("seasonPlanId") REFERENCES "SeasonPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MonthlyPlan" ADD CONSTRAINT "MonthlyPlan_seasonMonthId_fkey" FOREIGN KEY ("seasonMonthId") REFERENCES "SeasonMonth"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MonthlyPlan" ADD CONSTRAINT "MonthlyPlan_officerId_fkey" FOREIGN KEY ("officerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MonthExtensionRequest" ADD CONSTRAINT "MonthExtensionRequest_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MonthExtensionRequest" ADD CONSTRAINT "MonthExtensionRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MonthExtensionRequest" ADD CONSTRAINT "MonthExtensionRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
