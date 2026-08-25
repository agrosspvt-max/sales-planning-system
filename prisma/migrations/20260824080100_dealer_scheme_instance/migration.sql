-- Phase 2 Part A/B/N: first-class scheme instances (one per occurrence of a scheme for a dealer).

-- Multi-scheme billing mode flags on the parent plan.
ALTER TABLE "DealerSchemePlan"
  ADD COLUMN "soBillingSameForAll" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "adminBillingSameForAll" BOOLEAN NOT NULL DEFAULT true;

-- Instance table.
CREATE TABLE "DealerSchemeInstance" (
    "id" TEXT NOT NULL,
    "dealerSchemePlanId" TEXT NOT NULL,
    "instanceNumber" INTEGER NOT NULL,
    "soBillingDate" TIMESTAMP(3),
    "adminBillingDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DealerSchemeInstance_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DealerSchemeInstance_dealerSchemePlanId_idx" ON "DealerSchemeInstance"("dealerSchemePlanId");
CREATE UNIQUE INDEX "DealerSchemeInstance_dealerSchemePlanId_instanceNumber_key" ON "DealerSchemeInstance"("dealerSchemePlanId", "instanceNumber");
ALTER TABLE "DealerSchemeInstance" ADD CONSTRAINT "DealerSchemeInstance_dealerSchemePlanId_fkey" FOREIGN KEY ("dealerSchemePlanId") REFERENCES "DealerSchemePlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: create ONLY Instance 1 for every existing plan. Historically numberOfSchemes was just an
-- amount multiplier (NOT a count of real schedules), so legacy records must not fabricate instances 2..N.
-- Instance 1 inherits the plan's legacy billing dates so existing installments (re-parented in the next
-- migration) stay correctly dated. New-flow plans create their 2..N instances later, at runtime, via the
-- application's syncInstances (only while the plan is not yet enrolled).
INSERT INTO "DealerSchemeInstance" ("id", "dealerSchemePlanId", "instanceNumber", "soBillingDate", "adminBillingDate", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, p."id", 1, p."billingDate", p."adminBillingDate", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "DealerSchemePlan" p;
