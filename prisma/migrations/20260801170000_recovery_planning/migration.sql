-- Recovery Planning — the third planning module. Reuses PlanStatus + ApprovalAction.
-- Aging is stored normalised (snapshot -> dealer aggregate -> bills), never as JSON.

-- ApprovalAction gains recovery support; seasonPlanId becomes nullable (recovery has no season parent).
ALTER TABLE "ApprovalAction" ALTER COLUMN "seasonPlanId" DROP NOT NULL;
ALTER TABLE "ApprovalAction" ADD COLUMN "recoveryPlanId" TEXT;
CREATE INDEX "ApprovalAction_recoveryPlanId_idx" ON "ApprovalAction"("recoveryPlanId");

CREATE TABLE "RecoveryPlan" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "seasonMonthId" TEXT NOT NULL,
    "officerId" TEXT NOT NULL,
    "cutoffDate" TIMESTAMP(3) NOT NULL,
    "weeklyEditEnabled" BOOLEAN NOT NULL DEFAULT true,
    "status" "PlanStatus" NOT NULL DEFAULT 'DRAFT',
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "lastSavedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RecoveryPlan_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RecoveryPlan_seasonMonthId_officerId_key" ON "RecoveryPlan"("seasonMonthId", "officerId");
CREATE INDEX "RecoveryPlan_seasonId_idx" ON "RecoveryPlan"("seasonId");
CREATE INDEX "RecoveryPlan_officerId_idx" ON "RecoveryPlan"("officerId");
CREATE INDEX "RecoveryPlan_status_idx" ON "RecoveryPlan"("status");

CREATE TABLE "RecoveryPlanDealer" (
    "id" TEXT NOT NULL,
    "recoveryPlanId" TEXT NOT NULL,
    "dealerId" TEXT NOT NULL,
    "outstanding" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "overdue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "due" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "running" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "monthRecoveryPlan" DECIMAL(14,2),
    "monthRunningRecovery" DECIMAL(14,2),
    "noPlan" BOOLEAN NOT NULL DEFAULT false,
    "noPlanReason" TEXT,
    CONSTRAINT "RecoveryPlanDealer_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RecoveryPlanDealer_recoveryPlanId_dealerId_key" ON "RecoveryPlanDealer"("recoveryPlanId", "dealerId");
CREATE INDEX "RecoveryPlanDealer_recoveryPlanId_idx" ON "RecoveryPlanDealer"("recoveryPlanId");
CREATE INDEX "RecoveryPlanDealer_dealerId_idx" ON "RecoveryPlanDealer"("dealerId");

CREATE TABLE "RecoveryWeekPlan" (
    "id" TEXT NOT NULL,
    "recoveryPlanDealerId" TEXT NOT NULL,
    "weekNo" INTEGER NOT NULL,
    "weekRecoveryPlan" DECIMAL(14,2),
    "weekRunningRecovery" DECIMAL(14,2),
    CONSTRAINT "RecoveryWeekPlan_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RecoveryWeekPlan_recoveryPlanDealerId_weekNo_key" ON "RecoveryWeekPlan"("recoveryPlanDealerId", "weekNo");
CREATE INDEX "RecoveryWeekPlan_recoveryPlanDealerId_idx" ON "RecoveryWeekPlan"("recoveryPlanDealerId");

CREATE TABLE "AgingSnapshot" (
    "id" TEXT NOT NULL,
    "recoveryPlanId" TEXT NOT NULL,
    "weekNo" INTEGER NOT NULL,
    "cutoffDate" TIMESTAMP(3) NOT NULL,
    "workbookName" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "summary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgingSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AgingSnapshot_recoveryPlanId_weekNo_key" ON "AgingSnapshot"("recoveryPlanId", "weekNo");
CREATE INDEX "AgingSnapshot_recoveryPlanId_idx" ON "AgingSnapshot"("recoveryPlanId");

CREATE TABLE "AgingSnapshotDealer" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "dealerId" TEXT NOT NULL,
    "outstanding" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "overdue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "due" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "running" DECIMAL(14,2) NOT NULL DEFAULT 0,
    CONSTRAINT "AgingSnapshotDealer_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AgingSnapshotDealer_snapshotId_dealerId_key" ON "AgingSnapshotDealer"("snapshotId", "dealerId");
CREATE INDEX "AgingSnapshotDealer_snapshotId_idx" ON "AgingSnapshotDealer"("snapshotId");
CREATE INDEX "AgingSnapshotDealer_dealerId_idx" ON "AgingSnapshotDealer"("dealerId");

CREATE TABLE "AgingSnapshotBill" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "snapshotDealerId" TEXT NOT NULL,
    "dealerId" TEXT NOT NULL,
    "billDate" TIMESTAMP(3),
    "refNo" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "dueDate" TIMESTAMP(3),
    "bucket" TEXT NOT NULL,
    CONSTRAINT "AgingSnapshotBill_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AgingSnapshotBill_snapshotId_idx" ON "AgingSnapshotBill"("snapshotId");
CREATE INDEX "AgingSnapshotBill_snapshotDealerId_idx" ON "AgingSnapshotBill"("snapshotDealerId");
CREATE INDEX "AgingSnapshotBill_dealerId_idx" ON "AgingSnapshotBill"("dealerId");

ALTER TABLE "ApprovalAction" ADD CONSTRAINT "ApprovalAction_recoveryPlanId_fkey" FOREIGN KEY ("recoveryPlanId") REFERENCES "RecoveryPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecoveryPlan" ADD CONSTRAINT "RecoveryPlan_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RecoveryPlan" ADD CONSTRAINT "RecoveryPlan_seasonMonthId_fkey" FOREIGN KEY ("seasonMonthId") REFERENCES "SeasonMonth"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RecoveryPlan" ADD CONSTRAINT "RecoveryPlan_officerId_fkey" FOREIGN KEY ("officerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RecoveryPlanDealer" ADD CONSTRAINT "RecoveryPlanDealer_recoveryPlanId_fkey" FOREIGN KEY ("recoveryPlanId") REFERENCES "RecoveryPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecoveryPlanDealer" ADD CONSTRAINT "RecoveryPlanDealer_dealerId_fkey" FOREIGN KEY ("dealerId") REFERENCES "Dealer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RecoveryWeekPlan" ADD CONSTRAINT "RecoveryWeekPlan_recoveryPlanDealerId_fkey" FOREIGN KEY ("recoveryPlanDealerId") REFERENCES "RecoveryPlanDealer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgingSnapshot" ADD CONSTRAINT "AgingSnapshot_recoveryPlanId_fkey" FOREIGN KEY ("recoveryPlanId") REFERENCES "RecoveryPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgingSnapshot" ADD CONSTRAINT "AgingSnapshot_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgingSnapshotDealer" ADD CONSTRAINT "AgingSnapshotDealer_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "AgingSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgingSnapshotBill" ADD CONSTRAINT "AgingSnapshotBill_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "AgingSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgingSnapshotBill" ADD CONSTRAINT "AgingSnapshotBill_snapshotDealerId_fkey" FOREIGN KEY ("snapshotDealerId") REFERENCES "AgingSnapshotDealer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
