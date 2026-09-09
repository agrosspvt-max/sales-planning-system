-- Phase 11 — Pre-placement. ADDITIVE + non-destructive. Existing schemes/plans are unaffected:
-- prePlacementMaxDays defaults to 0 (pre-placement not available), and the per-plan day columns are NULL
-- (⇒ 0 confirmed days ⇒ installment schedule starts exactly at the billing date, unchanged from before).

-- Scheme: master ceiling for how many pre-placement days a dealer may be allowed.
ALTER TABLE "Scheme" ADD COLUMN "prePlacementMaxDays" INTEGER NOT NULL DEFAULT 0;

-- DealerSchemePlan: SO/dealer requested days + Admin confirmed/override (NULL ⇒ 0).
ALTER TABLE "DealerSchemePlan" ADD COLUMN "prePlacementDays" INTEGER;
ALTER TABLE "DealerSchemePlan" ADD COLUMN "adminPrePlacementDays" INTEGER;
