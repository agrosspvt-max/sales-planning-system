-- CreateTable
CREATE TABLE "LastPaymentImport" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL DEFAULT '',
    "fileHash" TEXT NOT NULL,
    "workbookName" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "summary" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LastPaymentImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LastPaymentReceipt" (
    "id" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "dealerId" TEXT NOT NULL,
    "rowKey" TEXT NOT NULL,
    "sourceOrder" INTEGER NOT NULL,
    "receiptDate" DATE NOT NULL,
    "creditAmount" DECIMAL(14,2) NOT NULL,
    "voucherNumber" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LastPaymentReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LastPaymentImport_kind_scopeKey_isActive_idx" ON "LastPaymentImport"("kind", "scopeKey", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "LastPaymentImport_kind_scopeKey_fileHash_key" ON "LastPaymentImport"("kind", "scopeKey", "fileHash");

-- CreateIndex
CREATE INDEX "LastPaymentReceipt_dealerId_receiptDate_idx" ON "LastPaymentReceipt"("dealerId", "receiptDate");

-- CreateIndex
CREATE UNIQUE INDEX "LastPaymentReceipt_importId_rowKey_key" ON "LastPaymentReceipt"("importId", "rowKey");

-- AddForeignKey
ALTER TABLE "LastPaymentImport" ADD CONSTRAINT "LastPaymentImport_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LastPaymentReceipt" ADD CONSTRAINT "LastPaymentReceipt_importId_fkey" FOREIGN KEY ("importId") REFERENCES "LastPaymentImport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LastPaymentReceipt" ADD CONSTRAINT "LastPaymentReceipt_dealerId_fkey" FOREIGN KEY ("dealerId") REFERENCES "Dealer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Protect the isolated store; no existing operational row/constraint is changed.
ALTER TABLE "LastPaymentImport" ADD CONSTRAINT "LastPaymentImport_kind_check" CHECK ("kind" IN ('HISTORICAL', 'REGULAR'));
ALTER TABLE "LastPaymentReceipt" ADD CONSTRAINT "LastPaymentReceipt_credit_check" CHECK ("creditAmount" > 0);
