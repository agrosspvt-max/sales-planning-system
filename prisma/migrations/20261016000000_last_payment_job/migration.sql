-- Durable hand-off of a regular Day Book upload to Last Payment processing (additive; no existing table is changed).
CREATE TABLE "LastPaymentJob" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'REGULAR_DAYBOOK',
    "scopeKey" TEXT NOT NULL,
    "workbookName" TEXT NOT NULL,
    "sourceFileHash" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastAttemptAt" TIMESTAMP(3),
    "outcome" TEXT,
    "importId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "LastPaymentJob_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LastPaymentJob_status_check" CHECK ("status" IN ('PENDING', 'FAILED', 'DONE'))
);

CREATE INDEX "LastPaymentJob_status_createdAt_idx" ON "LastPaymentJob"("status", "createdAt");
CREATE INDEX "LastPaymentJob_scopeKey_createdAt_idx" ON "LastPaymentJob"("scopeKey", "createdAt");
