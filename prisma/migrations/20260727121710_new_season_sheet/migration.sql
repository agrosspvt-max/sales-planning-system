-- AlterTable
ALTER TABLE "SeasonMonth" ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'OPEN';

-- CreateTable
CREATE TABLE "OnboardingRecord" (
    "id" TEXT NOT NULL,
    "runById" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'EXCEL',
    "sourceName" TEXT NOT NULL,
    "seasonId" TEXT,
    "officerId" TEXT,
    "status" "ImportStatus" NOT NULL DEFAULT 'COMPLETED',
    "report" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OnboardingRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OnboardingRecord_createdAt_idx" ON "OnboardingRecord"("createdAt");

-- AddForeignKey
ALTER TABLE "OnboardingRecord" ADD CONSTRAINT "OnboardingRecord_runById_fkey" FOREIGN KEY ("runById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
