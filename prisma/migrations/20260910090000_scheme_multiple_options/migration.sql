-- Phase 10 — Fixed vs Multiple Options for Scheme Planning. ADDITIVE + non-destructive.
-- Hand-written (Prisma engine download is 403-blocked in the build sandbox). Existing Fixed schemes are
-- untouched: `structure` defaults to FIXED, scheme-level values become nullable but keep their data, and no
-- requirement/plan/instalment/payment/SchemeSale rows are migrated or recalculated.

-- 1. New enums
CREATE TYPE "SchemeStructure" AS ENUM ('FIXED', 'MULTIPLE_OPTIONS');
CREATE TYPE "SchemeOptionAchievementType" AS ENUM ('QUANTITY_BASED', 'VALUE_BASED');

-- 2. Scheme: make scheme-level values nullable (MULTIPLE_OPTIONS stores NULL; FIXED keeps values) + new cols
ALTER TABLE "Scheme" ALTER COLUMN "schemeValueWithoutGST" DROP NOT NULL;
ALTER TABLE "Scheme" ALTER COLUMN "schemeValueWithGST" DROP NOT NULL;
ALTER TABLE "Scheme" ADD COLUMN "structure" "SchemeStructure" NOT NULL DEFAULT 'FIXED';
ALTER TABLE "Scheme" ADD COLUMN "optionAchievementType" "SchemeOptionAchievementType";

-- 3. SchemeOption
CREATE TABLE "SchemeOption" (
  "id" TEXT NOT NULL,
  "schemeId" TEXT NOT NULL,
  "label" TEXT,
  "targetQty" DECIMAL(14,3),
  "targetValue" DECIMAL(14,2),
  "valueWithoutGST" DECIMAL(14,2) NOT NULL,
  "valueWithGST" DECIMAL(14,2) NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "discontinuedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SchemeOption_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SchemeOption_schemeId_idx" ON "SchemeOption"("schemeId");
ALTER TABLE "SchemeOption" ADD CONSTRAINT "SchemeOption_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "Scheme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 4. SchemeEligibleProduct
CREATE TABLE "SchemeEligibleProduct" (
  "id" TEXT NOT NULL,
  "schemeId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SchemeEligibleProduct_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SchemeEligibleProduct_schemeId_productId_key" ON "SchemeEligibleProduct"("schemeId", "productId");
CREATE INDEX "SchemeEligibleProduct_schemeId_idx" ON "SchemeEligibleProduct"("schemeId");
CREATE INDEX "SchemeEligibleProduct_productId_idx" ON "SchemeEligibleProduct"("productId");
ALTER TABLE "SchemeEligibleProduct" ADD CONSTRAINT "SchemeEligibleProduct_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "Scheme"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SchemeEligibleProduct" ADD CONSTRAINT "SchemeEligibleProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 5. DealerSchemePlan: selected option + frozen snapshot (all NULL for FIXED plans)
ALTER TABLE "DealerSchemePlan" ADD COLUMN "selectedOptionId" TEXT;
ALTER TABLE "DealerSchemePlan" ADD COLUMN "optionLabel" TEXT;
ALTER TABLE "DealerSchemePlan" ADD COLUMN "optionTargetQty" DECIMAL(14,3);
ALTER TABLE "DealerSchemePlan" ADD COLUMN "optionTargetValue" DECIMAL(14,2);
ALTER TABLE "DealerSchemePlan" ADD COLUMN "optionValueWithoutGST" DECIMAL(14,2);
ALTER TABLE "DealerSchemePlan" ADD COLUMN "optionValueWithGST" DECIMAL(14,2);
CREATE INDEX "DealerSchemePlan_selectedOptionId_idx" ON "DealerSchemePlan"("selectedOptionId");
ALTER TABLE "DealerSchemePlan" ADD CONSTRAINT "DealerSchemePlan_selectedOptionId_fkey" FOREIGN KEY ("selectedOptionId") REFERENCES "SchemeOption"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
