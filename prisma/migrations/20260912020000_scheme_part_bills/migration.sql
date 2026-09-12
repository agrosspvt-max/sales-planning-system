-- No historical rows are converted, relinked, or recalculated.
ALTER TABLE "DealerSchemeInstance"
 ADD COLUMN "billMode" BOOLEAN NOT NULL DEFAULT false,
 ADD COLUMN "soBillCount" INTEGER,
 ADD COLUMN "adminBillCount" INTEGER,
 ADD COLUMN "adminAmountWithoutGST" DECIMAL(14,2),
 ADD COLUMN "adminAmountWithGST" DECIMAL(14,2),
 ADD COLUMN "bookingAmount" DECIMAL(14,2),
 ADD COLUMN "bookingBillNumber" INTEGER,
 ADD COLUMN "billsLockedAt" TIMESTAMP(3);
CREATE TABLE "DealerSchemeBill" (
 "id" TEXT PRIMARY KEY, "instanceId" TEXT NOT NULL, "partNumber" INTEGER NOT NULL,
 "soBillDate" TIMESTAMP(3), "adminBillDate" TIMESTAMP(3),
 "amountWithoutGST" DECIMAL(14,2), "amountWithGST" DECIMAL(14,2),
 "verifiedAt" TIMESTAMP(3), "verifiedById" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "DealerSchemeBill_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "DealerSchemeInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "DealerSchemeBill_partNumber_check" CHECK ("partNumber" BETWEEN 1 AND 5)
);
CREATE UNIQUE INDEX "DealerSchemeBill_instanceId_partNumber_key" ON "DealerSchemeBill"("instanceId", "partNumber");
CREATE UNIQUE INDEX "DealerSchemeBill_id_instanceId_key" ON "DealerSchemeBill"("id", "instanceId");
ALTER TABLE "DealerSchemeInstallment" ADD COLUMN "billId" TEXT;
ALTER TABLE "DealerSchemeInstallment" ADD CONSTRAINT "DealerSchemeInstallment_billId_instanceId_fkey"
 FOREIGN KEY ("billId", "instanceId") REFERENCES "DealerSchemeBill"("id", "instanceId") ON DELETE RESTRICT ON UPDATE CASCADE;
DROP INDEX "DealerSchemeInstallment_instanceId_installmentNumber_key";
CREATE UNIQUE INDEX "DealerSchemeInstallment_legacy_instance_number_key" ON "DealerSchemeInstallment"("instanceId", "installmentNumber") WHERE "billId" IS NULL;
CREATE UNIQUE INDEX "DealerSchemeInstallment_billId_installmentNumber_key" ON "DealerSchemeInstallment"("billId", "installmentNumber");
