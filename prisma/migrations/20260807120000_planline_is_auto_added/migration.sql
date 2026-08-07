-- Additive only: mark PlanLines that were auto-added by Sales Upload for an unplanned sold product.
-- Existing rows default to false; no planning data is modified.
ALTER TABLE "PlanLine" ADD COLUMN "isAutoAdded" BOOLEAN NOT NULL DEFAULT false;
