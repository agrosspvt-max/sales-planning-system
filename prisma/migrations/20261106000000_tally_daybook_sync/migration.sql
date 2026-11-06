-- CreateTable
CREATE TABLE "TallyDaybookJob" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "monthKey" TEXT NOT NULL,
    "fromDate" TEXT NOT NULL,
    "throughDate" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "claimRequestId" TEXT,
    "leaseHash" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "resultHash" TEXT,
    "summary" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "TallyDaybookJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TallyDaybookDealerMonth" (
    "monthKey" TEXT NOT NULL,
    "dealerId" TEXT NOT NULL,
    "throughDate" TEXT NOT NULL,
    "ledgerNames" TEXT[],
    "receiptDays" JSONB NOT NULL,
    "recoveryPlanId" TEXT,

    CONSTRAINT "TallyDaybookDealerMonth_pkey" PRIMARY KEY ("monthKey","dealerId")
);

-- CreateIndex
CREATE INDEX "TallyDaybookJob_connectionId_status_createdAt_idx" ON "TallyDaybookJob"("connectionId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "TallyDaybookJob_connectionId_monthKey_createdAt_idx" ON "TallyDaybookJob"("connectionId", "monthKey", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TallyDaybookJob_connectionId_claimRequestId_key" ON "TallyDaybookJob"("connectionId", "claimRequestId");

-- CreateIndex
CREATE INDEX "TallyDaybookDealerMonth_dealerId_monthKey_idx" ON "TallyDaybookDealerMonth"("dealerId", "monthKey");

-- AddForeignKey
ALTER TABLE "TallyDaybookJob" ADD CONSTRAINT "TallyDaybookJob_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "TallyConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TallyDaybookDealerMonth" ADD CONSTRAINT "TallyDaybookDealerMonth_dealerId_fkey" FOREIGN KEY ("dealerId") REFERENCES "Dealer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
