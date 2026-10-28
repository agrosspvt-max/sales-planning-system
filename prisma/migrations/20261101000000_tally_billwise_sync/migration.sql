-- AlterTable
ALTER TABLE "AgingSnapshot" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'AGING_UPLOAD',
ADD COLUMN     "sourceObservedAt" TIMESTAMP(3),
ADD COLUMN     "tallyJobId" TEXT;

-- CreateTable
CREATE TABLE "TallyConnection" (
    "id" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "anchorName" TEXT NOT NULL,
    "anchorGuid" TEXT NOT NULL,
    "credentialHash" TEXT NOT NULL,
    "authorizedById" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3),
    "requestWindowAt" TIMESTAMP(3),
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "lastPublishedAt" TIMESTAMP(3),
    "refreshRequestedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TallyConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TallySyncJob" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "asOf" TEXT NOT NULL,
    "scopeHash" TEXT NOT NULL,
    "scope" JSONB NOT NULL,
    "leaseHash" TEXT NOT NULL,
    "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
    "manifest" JSONB,
    "resultHash" TEXT,
    "summary" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "TallySyncJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TallySyncChunk" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "data" TEXT NOT NULL,

    CONSTRAINT "TallySyncChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TallyLedgerBinding" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "aliasKey" TEXT NOT NULL,
    "guid" TEXT NOT NULL,

    CONSTRAINT "TallyLedgerBinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TallyConnection_companyName_key" ON "TallyConnection"("companyName");

-- CreateIndex
CREATE INDEX "TallySyncJob_connectionId_status_idx" ON "TallySyncJob"("connectionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TallySyncChunk_jobId_sequence_key" ON "TallySyncChunk"("jobId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "TallyLedgerBinding_connectionId_aliasKey_key" ON "TallyLedgerBinding"("connectionId", "aliasKey");

-- CreateIndex
CREATE UNIQUE INDEX "TallyLedgerBinding_connectionId_guid_key" ON "TallyLedgerBinding"("connectionId", "guid");

-- AddForeignKey
ALTER TABLE "TallySyncJob" ADD CONSTRAINT "TallySyncJob_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "TallyConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TallySyncChunk" ADD CONSTRAINT "TallySyncChunk_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "TallySyncJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TallyLedgerBinding" ADD CONSTRAINT "TallyLedgerBinding_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "TallyConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

