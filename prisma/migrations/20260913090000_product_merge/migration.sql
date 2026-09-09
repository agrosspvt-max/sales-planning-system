-- Phase 12 — Product Merge / Consolidation. ADDITIVE + non-destructive. Existing products are unaffected:
-- mergedIntoId stays NULL (normal product), and no transactional/catalogue/plan data is touched by this
-- migration. A merge only sets the source product's mergedIntoId + deactivates it, consolidates catalogue
-- rows (survivor wins), reassigns scheme config, and writes a ProductMerge audit row — all at runtime.

-- Product: merge pointer + audit stamps (all nullable).
ALTER TABLE "Product" ADD COLUMN "mergedIntoId" TEXT;
ALTER TABLE "Product" ADD COLUMN "mergedAt" TIMESTAMP(3);
ALTER TABLE "Product" ADD COLUMN "mergedById" TEXT;
CREATE INDEX "Product_mergedIntoId_idx" ON "Product"("mergedIntoId");
ALTER TABLE "Product" ADD CONSTRAINT "Product_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ProductMerge: auditable, reversible record of each consolidation.
CREATE TABLE "ProductMerge" (
  "id" TEXT NOT NULL,
  "sourceProductId" TEXT NOT NULL,
  "survivingProductId" TEXT NOT NULL,
  "performedById" TEXT NOT NULL,
  "catalogueImpact" TEXT,
  "note" TEXT,
  "reversedAt" TIMESTAMP(3),
  "reversedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductMerge_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ProductMerge_sourceProductId_idx" ON "ProductMerge"("sourceProductId");
CREATE INDEX "ProductMerge_survivingProductId_idx" ON "ProductMerge"("survivingProductId");
CREATE INDEX "ProductMerge_createdAt_idx" ON "ProductMerge"("createdAt");
