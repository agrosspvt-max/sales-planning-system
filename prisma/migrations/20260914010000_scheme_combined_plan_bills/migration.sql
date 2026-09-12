-- Add combined-plan billing without reparenting, deleting, or recalculating any historical row.
ALTER TABLE "DealerSchemePlan"
 ADD COLUMN "billMode" BOOLEAN NOT NULL DEFAULT false,
 ADD COLUMN "soBillCount" INTEGER,
 ADD COLUMN "adminBillCount" INTEGER,
 ADD COLUMN "soAmountWithoutGST" DECIMAL(14,2),
 ADD COLUMN "soAmountWithGST" DECIMAL(14,2),
 ADD COLUMN "adminAmountWithoutGST" DECIMAL(14,2),
 ADD COLUMN "adminAmountWithGST" DECIMAL(14,2),
 ADD COLUMN "bookingAmount" DECIMAL(14,2),
 ADD COLUMN "bookingBillNumber" INTEGER,
 ADD COLUMN "billsLockedAt" TIMESTAMP(3);
ALTER TABLE "DealerSchemeBill"
 ALTER COLUMN "instanceId" DROP NOT NULL,
 ADD COLUMN "planId" TEXT,
 ADD COLUMN "soAmountWithoutGST" DECIMAL(14,2),
 ADD COLUMN "soAmountWithGST" DECIMAL(14,2),
 ADD CONSTRAINT "DealerSchemeBill_planId_fkey" FOREIGN KEY ("planId") REFERENCES "DealerSchemePlan"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 ADD CONSTRAINT "DealerSchemeBill_owner_check" CHECK (("instanceId" IS NULL) <> ("planId" IS NULL));
CREATE UNIQUE INDEX "DealerSchemeBill_planId_partNumber_key" ON "DealerSchemeBill"("planId", "partNumber");
ALTER TABLE "DealerSchemeInstallment"
 ALTER COLUMN "instanceId" DROP NOT NULL,
 ADD CONSTRAINT "DealerSchemeInstallment_billId_fkey" FOREIGN KEY ("billId") REFERENCES "DealerSchemeBill"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 ADD CONSTRAINT "DealerSchemeInstallment_owner_check" CHECK ("instanceId" IS NOT NULL OR "billId" IS NOT NULL);
-- Keep the existing composite FK in SQL: historical bill/instance links must still match.
-- New plan-bill installments have instanceId NULL and are protected by the simple billId FK.
-- Both legacy and per-bill installment uniqueness indexes remain unchanged.
