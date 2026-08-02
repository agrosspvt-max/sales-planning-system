-- Sales Upload (Tally actual-sales import) + Dealer Alias.
-- Actual quantities/values are written onto MonthlyEntry.saleQty / saleValue (existing
-- columns) — no per-row duplicate store. Only history and alias tables are added.

CREATE TABLE "DealerAlias" (
    "id" TEXT NOT NULL,
    "systemDealerId" TEXT NOT NULL,
    "tallyName" TEXT NOT NULL,
    "tallyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DealerAlias_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DealerAlias_tallyKey_key" ON "DealerAlias"("tallyKey");
CREATE INDEX "DealerAlias_systemDealerId_idx" ON "DealerAlias"("systemDealerId");
ALTER TABLE "DealerAlias" ADD CONSTRAINT "DealerAlias_systemDealerId_fkey" FOREIGN KEY ("systemDealerId") REFERENCES "Dealer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SalesUploadRun" (
    "id" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "workbookName" TEXT NOT NULL,
    "seasonMonthId" TEXT,
    "targetMonthName" TEXT NOT NULL,
    "fromDate" TIMESTAMP(3),
    "toDate" TIMESTAMP(3),
    "dealersUpdated" INTEGER NOT NULL DEFAULT 0,
    "productsUpdated" INTEGER NOT NULL DEFAULT 0,
    "rowsImported" INTEGER NOT NULL DEFAULT 0,
    "unknownDealers" INTEGER NOT NULL DEFAULT 0,
    "unknownProducts" INTEGER NOT NULL DEFAULT 0,
    "status" "ImportStatus" NOT NULL DEFAULT 'COMPLETED',
    "summary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SalesUploadRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SalesUploadRun_createdAt_idx" ON "SalesUploadRun"("createdAt");
ALTER TABLE "SalesUploadRun" ADD CONSTRAINT "SalesUploadRun_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
