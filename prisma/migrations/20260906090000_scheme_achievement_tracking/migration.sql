-- Scheme Achievement Requirement + Scheme Upload tracking.
--
-- ADDITIVE ONLY. This migration adds three new enums, four new tables, and three new columns on
-- "Scheme" (all defaulted/nullable so every existing scheme keeps working as an installment-only scheme
-- with requirementType = NONE). It NEVER modifies MonthlyEntry, PlanLine, PlanDealer, SalesUploadRun or
-- any other normal Sales Planning actual-sales record — Scheme Upload is a fully separate tracking layer.

-- ---------------------------------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------------------------------
CREATE TYPE "SchemeRequirementType" AS ENUM ('NONE', 'PRODUCT_BASED', 'VALUE_BASED');
CREATE TYPE "SchemeValueMode" AS ENUM ('INDIVIDUAL', 'COMBINED');
CREATE TYPE "SchemeUploadStatus" AS ENUM ('ACTIVE', 'SUPERSEDED');

-- ---------------------------------------------------------------------------------------------------
-- Scheme: achievement requirement configuration (installment tracking is unchanged and independent)
-- ---------------------------------------------------------------------------------------------------
ALTER TABLE "Scheme"
  ADD COLUMN "requirementType" "SchemeRequirementType" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "valueMode" "SchemeValueMode",
  ADD COLUMN "combinedRequiredValue" DECIMAL(14,2);

-- ---------------------------------------------------------------------------------------------------
-- SchemeRequirementProduct — the scheme's required products (qty for PRODUCT_BASED; per-product value
-- for VALUE_BASED + INDIVIDUAL; participating products only for VALUE_BASED + COMBINED).
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE "SchemeRequirementProduct" (
  "id"            TEXT NOT NULL,
  "schemeId"      TEXT NOT NULL,
  "productId"     TEXT NOT NULL,
  "requiredQty"   DECIMAL(14,3),
  "requiredValue" DECIMAL(14,2),
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SchemeRequirementProduct_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SchemeRequirementProduct_schemeId_productId_key" ON "SchemeRequirementProduct"("schemeId", "productId");
CREATE INDEX "SchemeRequirementProduct_schemeId_idx" ON "SchemeRequirementProduct"("schemeId");
CREATE INDEX "SchemeRequirementProduct_productId_idx" ON "SchemeRequirementProduct"("productId");

ALTER TABLE "SchemeRequirementProduct" ADD CONSTRAINT "SchemeRequirementProduct_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "Scheme"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SchemeRequirementProduct" ADD CONSTRAINT "SchemeRequirementProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------
-- SchemeUploadBatch — one date-range upload event (may target one or several schemes from one file).
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE "SchemeUploadBatch" (
  "id"           TEXT NOT NULL,
  "uploadedById" TEXT NOT NULL,
  "fileName"     TEXT NOT NULL,
  "startDate"    TIMESTAMP(3) NOT NULL,
  "endDate"      TIMESTAMP(3) NOT NULL,
  "summary"      TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SchemeUploadBatch_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SchemeUploadBatch_createdAt_idx" ON "SchemeUploadBatch"("createdAt");

ALTER TABLE "SchemeUploadBatch" ADD CONSTRAINT "SchemeUploadBatch_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------
-- SchemeUploadBatchScheme — the per-(scheme + date range) scope of a batch. This is the
-- replacement/idempotency key: re-uploading a scheme+range supersedes ONLY its own scope + sales.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE "SchemeUploadBatchScheme" (
  "id"              TEXT NOT NULL,
  "batchId"         TEXT NOT NULL,
  "schemeId"        TEXT NOT NULL,
  "startDate"       TIMESTAMP(3) NOT NULL,
  "endDate"         TIMESTAMP(3) NOT NULL,
  "status"          "SchemeUploadStatus" NOT NULL DEFAULT 'ACTIVE',
  "enrolledChecked" INTEGER NOT NULL DEFAULT 0,
  "matchedQty"      DECIMAL(14,3),
  "matchedValue"    DECIMAL(14,2),
  "supersededAt"    TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SchemeUploadBatchScheme_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SchemeUploadBatchScheme_schemeId_startDate_endDate_status_idx" ON "SchemeUploadBatchScheme"("schemeId", "startDate", "endDate", "status");
CREATE INDEX "SchemeUploadBatchScheme_batchId_idx" ON "SchemeUploadBatchScheme"("batchId");

ALTER TABLE "SchemeUploadBatchScheme" ADD CONSTRAINT "SchemeUploadBatchScheme_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "SchemeUploadBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SchemeUploadBatchScheme" ADD CONSTRAINT "SchemeUploadBatchScheme_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "Scheme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------
-- SchemeSale — tracked achievement facts. Each row hangs off exactly ONE scope
-- (SchemeUploadBatchScheme), which alone defines its batch + scheme + tracking range + ACTIVE/SUPERSEDED
-- state (so an invalid batch↔scheme pairing is structurally impossible). No per-row sale date is stored
-- (Decision A — the scope's start/end is the authoritative period). Each scheme has its own scope+sales,
-- so the SAME underlying sale contributes independently to every scheme (never globally consumed).
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE "SchemeSale" (
  "id"             TEXT NOT NULL,
  "scopeId"        TEXT NOT NULL,
  "dealerId"       TEXT NOT NULL,
  "productId"      TEXT NOT NULL,
  "qty"            DECIMAL(14,3) NOT NULL,
  "value"          DECIMAL(14,2) NOT NULL,
  "rawDealerName"  TEXT NOT NULL,
  "rawProductName" TEXT NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SchemeSale_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SchemeSale_scopeId_idx" ON "SchemeSale"("scopeId");
CREATE INDEX "SchemeSale_scopeId_dealerId_productId_idx" ON "SchemeSale"("scopeId", "dealerId", "productId");
CREATE INDEX "SchemeSale_dealerId_idx" ON "SchemeSale"("dealerId");
CREATE INDEX "SchemeSale_productId_idx" ON "SchemeSale"("productId");

ALTER TABLE "SchemeSale" ADD CONSTRAINT "SchemeSale_scopeId_fkey" FOREIGN KEY ("scopeId") REFERENCES "SchemeUploadBatchScheme"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SchemeSale" ADD CONSTRAINT "SchemeSale_dealerId_fkey" FOREIGN KEY ("dealerId") REFERENCES "Dealer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SchemeSale" ADD CONSTRAINT "SchemeSale_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
