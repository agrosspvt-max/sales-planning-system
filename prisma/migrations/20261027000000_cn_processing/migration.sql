-- CreateTable
CREATE TABLE "CnReviewAttempt" (
    "id" TEXT NOT NULL,
    "cnRequestId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestKey" TEXT NOT NULL,
    "assignedToId" TEXT NOT NULL,
    "assignedToName" TEXT NOT NULL,
    "sentById" TEXT NOT NULL,
    "sentByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),
    "note" TEXT,
    "products" JSONB NOT NULL,
    "document" TEXT,
    "fileName" TEXT,
    "mimeType" TEXT,

    CONSTRAINT "CnReviewAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CnProcessingEvent" (
    "id" TEXT NOT NULL,
    "cnRequestId" TEXT NOT NULL,
    "attemptId" TEXT,
    "kind" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "details" JSONB NOT NULL,

    CONSTRAINT "CnProcessingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CnReviewAttempt_requestKey_key" ON "CnReviewAttempt"("requestKey");

-- CreateIndex
CREATE INDEX "CnReviewAttempt_assignedToId_status_createdAt_idx" ON "CnReviewAttempt"("assignedToId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "CnReviewAttempt_cnRequestId_createdAt_idx" ON "CnReviewAttempt"("cnRequestId", "createdAt");

-- CreateIndex
CREATE INDEX "CnProcessingEvent_cnRequestId_createdAt_idx" ON "CnProcessingEvent"("cnRequestId", "createdAt");

-- AddForeignKey
ALTER TABLE "CnReviewAttempt" ADD CONSTRAINT "CnReviewAttempt_cnRequestId_fkey" FOREIGN KEY ("cnRequestId") REFERENCES "CnRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CnProcessingEvent" ADD CONSTRAINT "CnProcessingEvent_cnRequestId_fkey" FOREIGN KEY ("cnRequestId") REFERENCES "CnRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

