-- Existing rows become segment 1 without changing their quantities, amounts, or lifecycle state.
ALTER TABLE "DealerSchemePlan"
  ADD COLUMN "segmentNumber" INTEGER NOT NULL DEFAULT 1;

DROP INDEX "DealerSchemePlan_schemeId_dealerId_key";

CREATE UNIQUE INDEX "DealerSchemePlan_schemeId_dealerId_segmentNumber_key"
  ON "DealerSchemePlan"("schemeId", "dealerId", "segmentNumber");

CREATE INDEX "DealerSchemePlan_schemeId_dealerId_idx"
  ON "DealerSchemePlan"("schemeId", "dealerId");

CREATE TYPE "SchemePlanRemainderDisposition" AS ENUM ('CANCELLED', 'FUTURE_DRAFT');

CREATE TABLE "SchemePlanQuantitySplit" (
  "id" TEXT NOT NULL,
  "sourcePlanId" TEXT NOT NULL,
  "futurePlanId" TEXT,
  "originalQuantity" INTEGER NOT NULL,
  "proceedingQuantity" INTEGER NOT NULL,
  "remainingQuantity" INTEGER NOT NULL,
  "disposition" "SchemePlanRemainderDisposition" NOT NULL,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SchemePlanQuantitySplit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SchemePlanQuantitySplit_sourcePlanId_key"
  ON "SchemePlanQuantitySplit"("sourcePlanId");

CREATE UNIQUE INDEX "SchemePlanQuantitySplit_futurePlanId_key"
  ON "SchemePlanQuantitySplit"("futurePlanId");

CREATE INDEX "SchemePlanQuantitySplit_createdById_idx"
  ON "SchemePlanQuantitySplit"("createdById");

CREATE INDEX "SchemePlanQuantitySplit_disposition_idx"
  ON "SchemePlanQuantitySplit"("disposition");

ALTER TABLE "SchemePlanQuantitySplit"
  ADD CONSTRAINT "SchemePlanQuantitySplit_sourcePlanId_fkey"
  FOREIGN KEY ("sourcePlanId") REFERENCES "DealerSchemePlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SchemePlanQuantitySplit"
  ADD CONSTRAINT "SchemePlanQuantitySplit_futurePlanId_fkey"
  FOREIGN KEY ("futurePlanId") REFERENCES "DealerSchemePlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SchemePlanQuantitySplit"
  ADD CONSTRAINT "SchemePlanQuantitySplit_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
