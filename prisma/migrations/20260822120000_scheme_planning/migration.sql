-- Scheme Planning Phase 1: booking amount + installment rules + dealer scheme plans.

-- CreateEnum
CREATE TYPE "SchemeCalcType" AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT');
CREATE TYPE "SchemePlanStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'RM_APPROVED', 'RM_REJECTED', 'RETURNED');
CREATE TYPE "SchemeEnrollmentStatus" AS ENUM ('PENDING_DOCUMENT', 'ENROLLED');
CREATE TYPE "SchemeDocType" AS ENUM ('SOFT_COPY', 'HARD_COPY');

-- AlterTable
ALTER TABLE "Scheme" ADD COLUMN "bookingAmount" DECIMAL(14,2);
ALTER TABLE "Scheme" ADD COLUMN "otherBenefitDetails" TEXT;

-- CreateTable
CREATE TABLE "SchemeInstallmentRule" (
    "id" TEXT NOT NULL,
    "schemeId" TEXT NOT NULL,
    "installmentNumber" INTEGER NOT NULL,
    "calculationType" "SchemeCalcType" NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,
    "daysAfterBillingDate" INTEGER NOT NULL,
    CONSTRAINT "SchemeInstallmentRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealerSchemePlan" (
    "id" TEXT NOT NULL,
    "schemeId" TEXT NOT NULL,
    "dealerId" TEXT NOT NULL,
    "salesOfficerId" TEXT NOT NULL,
    "planningStatus" "SchemePlanStatus" NOT NULL DEFAULT 'DRAFT',
    "enrollmentStatus" "SchemeEnrollmentStatus" NOT NULL DEFAULT 'PENDING_DOCUMENT',
    "submittedAt" TIMESTAMP(3),
    "rmActedById" TEXT,
    "rmActedAt" TIMESTAMP(3),
    "rmRemarks" TEXT,
    "documentCompleted" BOOLEAN NOT NULL DEFAULT false,
    "documentType" "SchemeDocType",
    "verificationRemarks" TEXT,
    "enrolledById" TEXT,
    "enrolledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DealerSchemePlan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SchemeInstallmentRule_schemeId_idx" ON "SchemeInstallmentRule"("schemeId");
CREATE UNIQUE INDEX "SchemeInstallmentRule_schemeId_installmentNumber_key" ON "SchemeInstallmentRule"("schemeId", "installmentNumber");

CREATE INDEX "DealerSchemePlan_schemeId_idx" ON "DealerSchemePlan"("schemeId");
CREATE INDEX "DealerSchemePlan_dealerId_idx" ON "DealerSchemePlan"("dealerId");
CREATE INDEX "DealerSchemePlan_salesOfficerId_idx" ON "DealerSchemePlan"("salesOfficerId");
CREATE INDEX "DealerSchemePlan_planningStatus_idx" ON "DealerSchemePlan"("planningStatus");
CREATE INDEX "DealerSchemePlan_enrollmentStatus_idx" ON "DealerSchemePlan"("enrollmentStatus");
CREATE UNIQUE INDEX "DealerSchemePlan_schemeId_dealerId_key" ON "DealerSchemePlan"("schemeId", "dealerId");

-- AddForeignKey
ALTER TABLE "SchemeInstallmentRule" ADD CONSTRAINT "SchemeInstallmentRule_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "Scheme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DealerSchemePlan" ADD CONSTRAINT "DealerSchemePlan_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "Scheme"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DealerSchemePlan" ADD CONSTRAINT "DealerSchemePlan_dealerId_fkey" FOREIGN KEY ("dealerId") REFERENCES "Dealer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DealerSchemePlan" ADD CONSTRAINT "DealerSchemePlan_salesOfficerId_fkey" FOREIGN KEY ("salesOfficerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DealerSchemePlan" ADD CONSTRAINT "DealerSchemePlan_rmActedById_fkey" FOREIGN KEY ("rmActedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DealerSchemePlan" ADD CONSTRAINT "DealerSchemePlan_enrolledById_fkey" FOREIGN KEY ("enrolledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
