-- Explicit "confirmed for today's Daily Work" state for a materialized CN Auto Task.
-- This is SEPARATE from taskStatus / payment completion: it records only that the SO explicitly acknowledged
-- the task for today's Daily Plan. It is reset to false when the task is rescheduled to a future date.
-- Existing rows default to false (unconfirmed), so already-materialized tasks require an explicit Confirm.

ALTER TABLE "CnPaymentEvent"
  ADD COLUMN "dailyWorkConfirmed" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "CnRequest"
  ADD COLUMN "legacyDailyWorkConfirmed" BOOLEAN NOT NULL DEFAULT false;
