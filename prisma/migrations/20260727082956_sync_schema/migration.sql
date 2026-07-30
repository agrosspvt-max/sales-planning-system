/*
  Warnings:

  - A unique constraint covering the columns `[seasonId,officerId,planningType,version]` on the table `SeasonPlan` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "SeasonPlan_seasonId_officerId_version_key";

-- AlterTable
ALTER TABLE "MonthlyEntry" ADD COLUMN     "inputMode" TEXT,
ADD COLUMN     "planValue" DECIMAL(14,4),
ADD COLUMN     "saleValue" DECIMAL(14,4);

-- AlterTable
ALTER TABLE "PlanLine" ADD COLUMN     "inputMode" TEXT,
ADD COLUMN     "inputValue" DECIMAL(14,4);

-- AlterTable
ALTER TABLE "Season" ADD COLUMN     "endMonth" INTEGER,
ADD COLUMN     "endYear" INTEGER,
ADD COLUMN     "monthlyMode" TEXT NOT NULL DEFAULT 'PACK_SIZE',
ADD COLUMN     "seasonalMode" TEXT NOT NULL DEFAULT 'PACK_SIZE',
ADD COLUMN     "startMonth" INTEGER,
ADD COLUMN     "startYear" INTEGER;

-- AlterTable
ALTER TABLE "SeasonPlan" ADD COLUMN     "description" TEXT,
ADD COLUMN     "planningType" TEXT NOT NULL DEFAULT 'SEASONAL',
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "versionName" TEXT;

-- CreateTable
CREATE TABLE "SeasonPlanImportRecord" (
    "id" TEXT NOT NULL,
    "importedById" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "officerId" TEXT NOT NULL,
    "workbookName" TEXT NOT NULL,
    "dealerCount" INTEGER NOT NULL DEFAULT 0,
    "productRows" INTEGER NOT NULL DEFAULT 0,
    "status" "ImportStatus" NOT NULL DEFAULT 'COMPLETED',
    "summary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeasonPlanImportRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SeasonPlanImportRecord_createdAt_idx" ON "SeasonPlanImportRecord"("createdAt");

-- CreateIndex
CREATE INDEX "SeasonPlan_planningType_idx" ON "SeasonPlan"("planningType");

-- CreateIndex
CREATE UNIQUE INDEX "SeasonPlan_seasonId_officerId_planningType_version_key" ON "SeasonPlan"("seasonId", "officerId", "planningType", "version");

-- AddForeignKey
ALTER TABLE "SeasonPlanImportRecord" ADD CONSTRAINT "SeasonPlanImportRecord_importedById_fkey" FOREIGN KEY ("importedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
