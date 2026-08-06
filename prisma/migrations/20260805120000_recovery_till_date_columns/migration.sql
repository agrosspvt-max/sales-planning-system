-- Recovery month business columns (additive, non-destructive).
-- "Till Date" = OPENING balances for the Recovery month, frozen after the first import. SR/CR and
-- Live Recovery are columns only for now (default 0; Excel mapping / formulas to follow).

ALTER TABLE "RecoveryPlanDealer"
  ADD COLUMN "outstandingTillDate" DECIMAL(14,2),
  ADD COLUMN "runningTillDate"     DECIMAL(14,2),
  ADD COLUMN "srCr"                DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "liveRecovery"        DECIMAL(14,2) NOT NULL DEFAULT 0;

-- Back-fill opening balances for rows that already exist (created before this column): use their
-- current outstanding / running as the best-available opening value for the month. New rows created
-- from here on set these explicitly at creation time and never overwrite them afterwards.
UPDATE "RecoveryPlanDealer"
   SET "outstandingTillDate" = "outstanding",
       "runningTillDate"     = "running"
 WHERE "outstandingTillDate" IS NULL;
