-- Dealer completion workflow on PlanDealer: intentional "No Plan" skip + optional reason.
-- "Completed" and "Remaining" are derived at read time; only No Plan is persisted.
ALTER TABLE "PlanDealer" ADD COLUMN "noPlan" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PlanDealer" ADD COLUMN "noPlanReason" TEXT;
