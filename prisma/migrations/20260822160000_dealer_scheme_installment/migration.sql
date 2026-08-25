-- Enrolled Scheme operational layer: per-dealer installment schedule + payments.
CREATE TABLE "DealerSchemeInstallment" (
    "id" TEXT NOT NULL,
    "dealerSchemePlanId" TEXT NOT NULL,
    "installmentNumber" INTEGER NOT NULL,
    "plannedAmount" DECIMAL(14,2) NOT NULL,
    "plannedDate" TIMESTAMP(3),
    "receivedAmount" DECIMAL(14,2),
    "receivedDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DealerSchemeInstallment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DealerSchemeInstallment_dealerSchemePlanId_idx" ON "DealerSchemeInstallment"("dealerSchemePlanId");
CREATE UNIQUE INDEX "DealerSchemeInstallment_dealerSchemePlanId_installmentNumber_key" ON "DealerSchemeInstallment"("dealerSchemePlanId", "installmentNumber");

ALTER TABLE "DealerSchemeInstallment" ADD CONSTRAINT "DealerSchemeInstallment_dealerSchemePlanId_fkey" FOREIGN KEY ("dealerSchemePlanId") REFERENCES "DealerSchemePlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
