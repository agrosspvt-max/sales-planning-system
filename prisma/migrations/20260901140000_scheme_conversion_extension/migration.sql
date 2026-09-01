-- Conversion Date Extension feature. All additive & safe: existing rows default to 0 extension config /
-- 0 extensions used, and originalConversionDate stays NULL until first set.

-- 1) Scheme configuration.
ALTER TABLE "Scheme" ADD COLUMN "maxExtensionDays" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Scheme" ADD COLUMN "maxExtensionAttempts" INTEGER NOT NULL DEFAULT 0;

-- 2) Per-plan extension baseline + denormalized count (history table is the source of truth).
ALTER TABLE "DealerSchemePlan" ADD COLUMN "originalConversionDate" TIMESTAMP(3);
ALTER TABLE "DealerSchemePlan" ADD COLUMN "conversionExtensionCount" INTEGER NOT NULL DEFAULT 0;

-- 3) Immutable extension history.
CREATE TABLE "SchemeConversionExtension" (
  "id" TEXT NOT NULL,
  "planId" TEXT NOT NULL,
  "extensionNumber" INTEGER NOT NULL,
  "originalConversionDate" TIMESTAMP(3) NOT NULL,
  "previousConversionDate" TIMESTAMP(3) NOT NULL,
  "newConversionDate" TIMESTAMP(3) NOT NULL,
  "daysAdded" INTEGER NOT NULL,
  "extendedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SchemeConversionExtension_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SchemeConversionExtension_planId_extensionNumber_key" ON "SchemeConversionExtension"("planId", "extensionNumber");
CREATE INDEX "SchemeConversionExtension_planId_idx" ON "SchemeConversionExtension"("planId");
ALTER TABLE "SchemeConversionExtension" ADD CONSTRAINT "SchemeConversionExtension_planId_fkey" FOREIGN KEY ("planId") REFERENCES "DealerSchemePlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SchemeConversionExtension" ADD CONSTRAINT "SchemeConversionExtension_extendedById_fkey" FOREIGN KEY ("extendedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
