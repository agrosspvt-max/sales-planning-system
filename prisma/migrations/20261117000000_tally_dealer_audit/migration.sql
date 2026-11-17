CREATE TABLE "TallyDealerAudit" (
    "connectionId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "claimRequestId" TEXT NOT NULL,
    "dayKey" TEXT NOT NULL,
    "leaseHash" TEXT NOT NULL,
    "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
    "publishedDay" TEXT,
    "completedAt" TIMESTAMP(3),
    "resultHash" TEXT,
    "summary" JSONB,
    "error" TEXT,
    CONSTRAINT "TallyDealerAudit_pkey" PRIMARY KEY ("connectionId"),
    CONSTRAINT "TallyDealerAudit_connectionId_fkey" FOREIGN KEY ("connectionId")
        REFERENCES "TallyConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
