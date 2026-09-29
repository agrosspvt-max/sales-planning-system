-- New CN payment tracking is opt-in per request. NULL mode keeps historical taskDate rows on the legacy path.
ALTER TABLE "CnRequest"
  ADD COLUMN "paymentOriginalAmount" DECIMAL(14,2),
  ADD COLUMN "paymentOutstandingAmount" DECIMAL(14,2),
  ADD COLUMN "paymentTrackingMode" TEXT;

-- Each immutable payment event may also own the Recovery follow-up task created by that decision.
CREATE TABLE "CnPaymentEvent" (
  "id" TEXT NOT NULL,
  "cnRequestId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "amountPaid" DECIMAL(14,2),
  "eventDate" DATE NOT NULL,
  "outstandingBefore" DECIMAL(14,2) NOT NULL,
  "outstandingAfter" DECIMAL(14,2) NOT NULL,
  "taskAmount" DECIMAL(14,2),
  "taskDate" DATE,
  "taskStatus" TEXT,
  "taskCompletedAt" TIMESTAMP(3),
  "source" TEXT NOT NULL,
  "requestKey" TEXT NOT NULL,
  "recordedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CnPaymentEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CnPaymentEvent_requestKey_key" ON "CnPaymentEvent"("requestKey");
CREATE INDEX "CnPaymentEvent_cnRequestId_createdAt_idx" ON "CnPaymentEvent"("cnRequestId", "createdAt");
CREATE INDEX "CnPaymentEvent_cnRequestId_taskStatus_idx" ON "CnPaymentEvent"("cnRequestId", "taskStatus");
CREATE INDEX "CnPaymentEvent_taskDate_idx" ON "CnPaymentEvent"("taskDate");

ALTER TABLE "CnPaymentEvent" ADD CONSTRAINT "CnPaymentEvent_cnRequestId_fkey"
  FOREIGN KEY ("cnRequestId") REFERENCES "CnRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CnPaymentEvent" ADD CONSTRAINT "CnPaymentEvent_recordedById_fkey"
  FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Deliberately no UPDATE/backfill: existing amounts, statuses and legacy CN task dates retain their meaning.
