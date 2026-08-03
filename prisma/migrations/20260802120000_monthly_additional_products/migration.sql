-- Additional Products + Create Dealer from Monthly Planning. Minimal additive columns; the
-- approved Seasonal Plan is never modified (additional lines carry zero seasonal quantity and
-- are excluded from seasonal views via the flags below).

-- Dealer lifecycle + optional contact metadata.
ALTER TABLE "Dealer" ADD COLUMN "mobile" TEXT;
ALTER TABLE "Dealer" ADD COLUMN "village" TEXT;
ALTER TABLE "Dealer" ADD COLUMN "tehsil" TEXT;
ALTER TABLE "Dealer" ADD COLUMN "district" TEXT;
ALTER TABLE "Dealer" ADD COLUMN "address" TEXT;
ALTER TABLE "Dealer" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "Dealer" ADD COLUMN "createdByUserId" TEXT;
ALTER TABLE "Dealer" ADD COLUMN "createdFrom" TEXT;
CREATE INDEX "Dealer_status_idx" ON "Dealer"("status");

-- Monthly-only additional product line (not part of the approved Seasonal Plan).
ALTER TABLE "PlanLine" ADD COLUMN "isAdditional" BOOLEAN NOT NULL DEFAULT false;

-- A dealer added to a plan from Monthly Planning (new dealer) — excluded from seasonal views.
ALTER TABLE "PlanDealer" ADD COLUMN "fromMonthlyPlan" BOOLEAN NOT NULL DEFAULT false;
