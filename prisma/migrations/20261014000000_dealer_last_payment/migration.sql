-- Persistent latest-payment state for the Last Payment Report. Additive only: two new tables, no change to existing data. Existing payments are copied in by the
-- separate, restartable, dry-run-by-default script scripts/backfill-dealer-last-payment.ts (nothing is populated by this migration, and nothing is applied automatically).
CREATE TABLE "DealerPaymentReceipt" (
    "id" TEXT NOT NULL,
    "dealerId" TEXT NOT NULL,
    "receiptDate" DATE NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "occurrence" INTEGER NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "importId" TEXT,
    "sourceOrder" INTEGER,
    "voucherNumber" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DealerPaymentReceipt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DealerLastPayment" (
    "dealerId" TEXT NOT NULL,
    "paymentDate" DATE NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "basis" TEXT NOT NULL,
    "asOfDate" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DealerLastPayment_pkey" PRIMARY KEY ("dealerId")
);

-- Receipt identity: (dealer, date, amount, occurrence). Re-delivery of the same receipt maps to the same key; identical genuine repeats get distinct occurrences.
CREATE UNIQUE INDEX "DealerPaymentReceipt_dealerId_receiptDate_amount_occurrence_key" ON "DealerPaymentReceipt"("dealerId", "receiptDate", "amount", "occurrence");
CREATE INDEX "DealerPaymentReceipt_dealerId_receiptDate_idx" ON "DealerPaymentReceipt"("dealerId", "receiptDate");

-- RESTRICT: payment history is never cascaded away with a dealer.
ALTER TABLE "DealerPaymentReceipt" ADD CONSTRAINT "DealerPaymentReceipt_dealerId_fkey" FOREIGN KEY ("dealerId") REFERENCES "Dealer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DealerLastPayment" ADD CONSTRAINT "DealerLastPayment_dealerId_fkey" FOREIGN KEY ("dealerId") REFERENCES "Dealer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
