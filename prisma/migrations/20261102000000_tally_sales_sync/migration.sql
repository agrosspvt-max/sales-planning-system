-- AlterTable
ALTER TABLE "MonthlyEntry" ALTER COLUMN "saleQty" SET DEFAULT 0,
ALTER COLUMN "saleQty" SET DATA TYPE DECIMAL(18,6);

-- CreateTable
CREATE TABLE "TallySalesJob" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "monthKey" TEXT NOT NULL,
    "fromDate" TEXT NOT NULL,
    "throughDate" TEXT NOT NULL,
    "manual" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "claimRequestId" TEXT,
    "scope" JSONB,
    "scopeHash" TEXT,
    "leaseHash" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "manifest" JSONB,
    "resultHash" TEXT,
    "summary" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "TallySalesJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TallySalesChunk" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "data" TEXT NOT NULL,

    CONSTRAINT "TallySalesChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TallySalesSnapshot" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "monthKey" TEXT NOT NULL,
    "fromDate" TEXT NOT NULL,
    "throughDate" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "summary" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TallySalesSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TallySalesVoucher" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "guid" TEXT NOT NULL,
    "masterId" TEXT NOT NULL,
    "alterId" TEXT NOT NULL,
    "billDate" TEXT NOT NULL,
    "billNumber" TEXT NOT NULL,
    "typeName" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "partyName" TEXT NOT NULL,
    "cancelled" BOOLEAN NOT NULL,
    "optional" BOOLEAN NOT NULL,
    "ledgerEntries" JSONB NOT NULL,

    CONSTRAINT "TallySalesVoucher_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TallySalesItem" (
    "id" TEXT NOT NULL,
    "voucherId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "stockItemName" TEXT NOT NULL,
    "quantity" DECIMAL(18,6) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "unit" TEXT NOT NULL,
    "actualQty" TEXT NOT NULL,
    "billedQty" TEXT NOT NULL,
    "rate" TEXT NOT NULL,

    CONSTRAINT "TallySalesItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TallySalesJob_connectionId_status_idx" ON "TallySalesJob"("connectionId", "status");

-- CreateIndex
CREATE INDEX "TallySalesJob_connectionId_monthKey_createdAt_idx" ON "TallySalesJob"("connectionId", "monthKey", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TallySalesJob_connectionId_claimRequestId_key" ON "TallySalesJob"("connectionId", "claimRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "TallySalesChunk_jobId_sequence_key" ON "TallySalesChunk"("jobId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "TallySalesSnapshot_connectionId_monthKey_key" ON "TallySalesSnapshot"("connectionId", "monthKey");

-- CreateIndex
CREATE INDEX "TallySalesVoucher_partyName_billDate_idx" ON "TallySalesVoucher"("partyName", "billDate");

-- CreateIndex
CREATE UNIQUE INDEX "TallySalesVoucher_snapshotId_guid_key" ON "TallySalesVoucher"("snapshotId", "guid");

-- CreateIndex
CREATE UNIQUE INDEX "TallySalesItem_voucherId_lineNo_key" ON "TallySalesItem"("voucherId", "lineNo");

-- AddForeignKey
ALTER TABLE "TallySalesJob" ADD CONSTRAINT "TallySalesJob_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "TallyConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TallySalesChunk" ADD CONSTRAINT "TallySalesChunk_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "TallySalesJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TallySalesSnapshot" ADD CONSTRAINT "TallySalesSnapshot_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "TallyConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TallySalesVoucher" ADD CONSTRAINT "TallySalesVoucher_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "TallySalesSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TallySalesItem" ADD CONSTRAINT "TallySalesItem_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "TallySalesVoucher"("id") ON DELETE CASCADE ON UPDATE CASCADE;
