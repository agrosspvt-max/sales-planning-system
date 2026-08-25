-- Part E: new Plan Status / Scheme Status model + conversion + admin verification fields.
-- Old planningStatus / enrollmentStatus columns are kept for a safe, incremental migration.

-- CreateEnum
CREATE TYPE "SchemePlanState" AS ENUM ('DRAFT', 'PENDING_RM', 'PENDING_APPROVAL', 'APPROVED', 'RETURNED', 'REJECTED');
CREATE TYPE "SchemeConversionStatus" AS ENUM ('PENDING', 'CONVERTED', 'DECLINED');
CREATE TYPE "SchemeBookingStatus" AS ENUM ('RECEIVED', 'NOT_RECEIVED', 'PARTIAL');
CREATE TYPE "SchemeSoDocStatus" AS ENUM ('IN_TRANSIT', 'RECEIVED', 'NOT_RECEIVED');
CREATE TYPE "SchemeAdminDocStatus" AS ENUM ('RECEIVED_SOFT', 'RECEIVED_HARD', 'NOT_RECEIVED');

-- AlterTable
ALTER TABLE "DealerSchemePlan"
  ADD COLUMN "planStatus" "SchemePlanState" NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN "schemeStatus" "SchemeConversionStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "numberOfSchemes" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "totalSchemeAmount" DECIMAL(14,2),
  ADD COLUMN "conversionDate" TIMESTAMP(3),
  ADD COLUMN "soBookingStatus" "SchemeBookingStatus",
  ADD COLUMN "soBookingAmount" DECIMAL(14,2),
  ADD COLUMN "soDocumentStatus" "SchemeSoDocStatus",
  ADD COLUMN "billingDate" TIMESTAMP(3),
  ADD COLUMN "adminBookingStatus" "SchemeBookingStatus",
  ADD COLUMN "adminBookingAmount" DECIMAL(14,2),
  ADD COLUMN "adminDocumentStatus" "SchemeAdminDocStatus",
  ADD COLUMN "adminVerifiedById" TEXT,
  ADD COLUMN "adminVerifiedAt" TIMESTAMP(3);

-- Backfill planStatus from the existing planningStatus so current data stays consistent.
UPDATE "DealerSchemePlan" SET "planStatus" = 'DRAFT'            WHERE "planningStatus" = 'DRAFT';
UPDATE "DealerSchemePlan" SET "planStatus" = 'PENDING_RM'       WHERE "planningStatus" = 'SUBMITTED';
UPDATE "DealerSchemePlan" SET "planStatus" = 'PENDING_APPROVAL' WHERE "planningStatus" = 'RM_APPROVED';
UPDATE "DealerSchemePlan" SET "planStatus" = 'RETURNED'         WHERE "planningStatus" = 'RETURNED';
UPDATE "DealerSchemePlan" SET "planStatus" = 'REJECTED'         WHERE "planningStatus" = 'RM_REJECTED';
-- Already-enrolled dealers are approved + converted in the new model.
UPDATE "DealerSchemePlan" SET "planStatus" = 'APPROVED', "schemeStatus" = 'CONVERTED' WHERE "enrollmentStatus" = 'ENROLLED';

-- CreateIndex
CREATE INDEX "DealerSchemePlan_planStatus_idx" ON "DealerSchemePlan"("planStatus");
CREATE INDEX "DealerSchemePlan_schemeStatus_idx" ON "DealerSchemePlan"("schemeStatus");
