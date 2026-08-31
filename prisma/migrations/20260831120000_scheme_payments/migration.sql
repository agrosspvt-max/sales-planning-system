-- Payment Management: actual money-received transactions for enrolled scheme plans, and the per-installment
-- allocation of each transaction. Additive only — no existing table/column is modified. The installment's
-- own receivedAmount/receivedDate remain the denormalised rollup maintained by the allocation logic.

CREATE TABLE "SchemePayment" (
  "id"           TEXT NOT NULL,
  "planId"       TEXT NOT NULL,
  "amount"       DECIMAL(14,2) NOT NULL,
  "receivedDate" TIMESTAMP(3) NOT NULL,
  "recordedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdById"  TEXT NOT NULL,
  "note"         TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SchemePayment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SchemePayment_planId_idx" ON "SchemePayment"("planId");
CREATE INDEX "SchemePayment_recordedAt_idx" ON "SchemePayment"("recordedAt");
CREATE INDEX "SchemePayment_receivedDate_idx" ON "SchemePayment"("receivedDate");

ALTER TABLE "SchemePayment" ADD CONSTRAINT "SchemePayment_planId_fkey" FOREIGN KEY ("planId") REFERENCES "DealerSchemePlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SchemePayment" ADD CONSTRAINT "SchemePayment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "SchemePaymentAllocation" (
  "id"            TEXT NOT NULL,
  "paymentId"     TEXT NOT NULL,
  "installmentId" TEXT NOT NULL,
  "amount"        DECIMAL(14,2) NOT NULL,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SchemePaymentAllocation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SchemePaymentAllocation_paymentId_idx" ON "SchemePaymentAllocation"("paymentId");
CREATE INDEX "SchemePaymentAllocation_installmentId_idx" ON "SchemePaymentAllocation"("installmentId");

ALTER TABLE "SchemePaymentAllocation" ADD CONSTRAINT "SchemePaymentAllocation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "SchemePayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SchemePaymentAllocation" ADD CONSTRAINT "SchemePaymentAllocation_installmentId_fkey" FOREIGN KEY ("installmentId") REFERENCES "DealerSchemeInstallment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
