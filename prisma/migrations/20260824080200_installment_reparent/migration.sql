-- Phase 2 Part F/H/N: re-parent DealerSchemeInstallment from DealerSchemePlan to DealerSchemeInstance.
-- Additive-then-swap; existing installment rows are preserved and attached to their plan's Instance 1.

-- 1) Add nullable instanceId.
ALTER TABLE "DealerSchemeInstallment" ADD COLUMN "instanceId" TEXT;

-- 2) Backfill: point every existing installment at its plan's Instance 1 (created in the previous migration).
UPDATE "DealerSchemeInstallment" i
SET "instanceId" = inst."id"
FROM "DealerSchemeInstance" inst
WHERE inst."dealerSchemePlanId" = i."dealerSchemePlanId" AND inst."instanceNumber" = 1;

-- 3) Drop the old plan relation (FK, indexes, column).
ALTER TABLE "DealerSchemeInstallment" DROP CONSTRAINT IF EXISTS "DealerSchemeInstallment_dealerSchemePlanId_fkey";
-- The old unique index exists under the canonical name after 20260824075359_dealer_scheme_view
-- ("..._installmentNumbe_key"); the IF EXISTS on the naive 63-char truncation ("..._installmentNumber_ke")
-- is a harmless safety net for any environment that never ran the rename.
DROP INDEX IF EXISTS "DealerSchemeInstallment_dealerSchemePlanId_installmentNumbe_key";
DROP INDEX IF EXISTS "DealerSchemeInstallment_dealerSchemePlanId_installmentNumber_key";
DROP INDEX IF EXISTS "DealerSchemeInstallment_dealerSchemePlanId_idx";
ALTER TABLE "DealerSchemeInstallment" DROP COLUMN "dealerSchemePlanId";

-- 4) Enforce the new instance relation.
ALTER TABLE "DealerSchemeInstallment" ALTER COLUMN "instanceId" SET NOT NULL;
CREATE INDEX "DealerSchemeInstallment_instanceId_idx" ON "DealerSchemeInstallment"("instanceId");
CREATE UNIQUE INDEX "DealerSchemeInstallment_instanceId_installmentNumber_key" ON "DealerSchemeInstallment"("instanceId", "installmentNumber");
ALTER TABLE "DealerSchemeInstallment" ADD CONSTRAINT "DealerSchemeInstallment_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "DealerSchemeInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
